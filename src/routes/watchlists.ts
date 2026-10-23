import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../feed/query";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";
import { requireApiKey, type AuthEnv } from "../middleware/auth";
import { newWebhookSecret } from "../queue/sign";
import { FALLBACK_MAX_URL_LENGTH, parseDelivery, parseWatchlistBody, type WatchlistFilter } from "../watchlists/filter";
import { buildWatchlistEventsQuery } from "../watchlists/query";

// Code fallback only. The live cap is settings.watchlists.max_body_bytes.
export const FALLBACK_MAX_BODY_BYTES = 1_048_576;
// Code fallback only. The live value is settings.webhooks.deliveries_list_limit,
// read as 1..100 (CLAUDE.md rule 8: page cap 100).
export const FALLBACK_DELIVERIES_LIST_LIMIT = 100;
export const DELIVERIES_LIST_MAX = 100;

// One guarded statement: the count check and the insert are atomic, so two
// parallel creates cannot pass plans.max_watchlists. A new list starts at the
// newest feed cursor, so it answers new events only. ?1..?7 as before;
// ?8 delivery, ?9 webhook_url, ?10 webhook_secret.
export const CREATE_WATCHLIST_SQL = `INSERT INTO watchlists (id, key_id, name, filter_json, cursor, delivery, webhook_url, webhook_secret, created_at)
  SELECT ?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(cursor), 0) FROM advisories), COALESCE(?8, 'poll'), ?9, ?10, ?5
  WHERE (SELECT COUNT(*) FROM watchlists WHERE key_id = ?6) < ?7
  RETURNING cursor`;

// Bounded by plans.max_watchlists. Never selects webhook_secret.
export const LIST_WATCHLISTS_SQL =
  "SELECT id, name, filter_json, cursor, delivery, webhook_url, created_at FROM watchlists WHERE key_id = ? ORDER BY created_at, id";

// Scoped to the caller's key in the same statement. idx_deliveries_watchlist_cursor.
export const DELIVERIES_LIST_SQL = `SELECT d.advisory_id, d.cursor, d.status, d.attempt, d.last_code, d.next_at, d.delivered_at
  FROM deliveries d JOIN watchlists w ON w.id = d.watchlist_id
  WHERE d.watchlist_id = ?1 AND w.key_id = ?2 ORDER BY d.cursor DESC LIMIT ?3`;

const WEBHOOKS_OFF = { error: "webhooks not enabled for this plan" };

const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = Context<AuthEnv>;
const answer = (c: Ctx, body: unknown, status: ContentfulStatusCode = 200) => jsonUtf8(c, body, status, NO_STORE);

interface ListRow {
  id: string;
  name: string;
  filter_json: string;
  cursor: number;
  delivery: string;
  webhook_url: string | null;
  created_at: string;
}

const watchlists = new Hono<AuthEnv>();

watchlists.use("*", requireApiKey);

// The body cap of POST and PATCH (settings.watchlists.max_body_bytes).
const capBody: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const maxSize = await getSettingInt(c.env.DB, "watchlists.max_body_bytes", FALLBACK_MAX_BODY_BYTES);
  return bodyLimit({ maxSize, onError: (c) => answer(c, { error: `body over ${maxSize} bytes` }, 413) })(c, next);
};

const NOT_JSON = Symbol("not json");

// The JSON body and the webhook_url length cap, read in parallel.
async function readBody(c: Ctx): Promise<[unknown, number]> {
  return Promise.all([
    c.req.json().catch(() => NOT_JSON),
    getSettingInt(c.env.DB, "webhooks.max_url_length", FALLBACK_MAX_URL_LENGTH),
  ]);
}

watchlists.post("/", capBody, async (c) => {
  const [body, maxUrlLength] = await readBody(c);
  if (body === NOT_JSON) return answer(c, { error: "body must be JSON" }, 400);
  const parsed = parseWatchlistBody(body, maxUrlLength);
  if (!parsed.ok) return answer(c, { error: parsed.error }, 400);

  const { id: keyId, limits } = c.var.apiKey;
  // The plan gate (plans.webhooks), before any write.
  if (parsed.delivery.delivery === "webhook" && limits.webhooks !== 1) return answer(c, WEBHOOKS_OFF, 403);
  if (parsed.filter.components.length > limits.max_components) {
    return answer(c, { error: "component limit reached", max_components: limits.max_components }, 403);
  }

  const id = "wl_" + crypto.randomUUID();
  const created_at = new Date().toISOString();
  const secret = parsed.delivery.delivery === "webhook" ? newWebhookSecret() : null;
  const row = await c.env.DB.prepare(CREATE_WATCHLIST_SQL)
    .bind(id, keyId, parsed.name, JSON.stringify(parsed.filter), created_at, keyId, limits.max_watchlists, parsed.delivery.delivery, parsed.delivery.webhook_url, secret)
    .first<{ cursor: number }>();
  if (!row) return answer(c, { error: "watch list limit reached", max_watchlists: limits.max_watchlists }, 403);

  // The secret is in this answer only; no other route returns it.
  const hook = secret ? { webhook_url: parsed.delivery.webhook_url, webhook_secret: secret } : {};
  return answer(c, { id, name: parsed.name, filter: parsed.filter, cursor: row.cursor, delivery: parsed.delivery.delivery, ...hook, created_at }, 201);
});

// Changes how a list is delivered. A switch to webhook (or a new URL) makes a
// new secret and returns it once; poll clears the URL and the secret.
watchlists.patch("/:id", capBody, async (c) => {
  const [body, maxUrlLength] = await readBody(c);
  if (body === NOT_JSON) return answer(c, { error: "body must be JSON" }, 400);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return answer(c, { error: "body must be a JSON object" }, 400);
  const b = body as Record<string, unknown>;
  if (b.delivery === undefined) return answer(c, { error: "delivery is required" }, 400);
  const parsed = parseDelivery(b, maxUrlLength);
  if (!parsed.ok) return answer(c, { error: parsed.error }, 400);

  const { id: keyId, limits } = c.var.apiKey;
  if (parsed.value.delivery === "webhook" && limits.webhooks !== 1) return answer(c, WEBHOOKS_OFF, 403);

  const id = c.req.param("id");
  const secret = parsed.value.delivery === "webhook" ? newWebhookSecret() : null;
  const res = await c.env.DB.prepare("UPDATE watchlists SET delivery = ?, webhook_url = ?, webhook_secret = ? WHERE id = ? AND key_id = ?")
    .bind(parsed.value.delivery, parsed.value.webhook_url, secret, id, keyId)
    .run();
  if (res.meta.changes === 0) return answer(c, { error: "not found" }, 404);
  const hook = secret ? { webhook_url: parsed.value.webhook_url, webhook_secret: secret } : { webhook_url: null };
  return answer(c, { id, delivery: parsed.value.delivery, ...hook });
});

watchlists.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(LIST_WATCHLISTS_SQL).bind(c.var.apiKey.id).all<ListRow>();
  return answer(c, {
    watchlists: results.map(({ filter_json, ...r }) => ({ ...r, filter: JSON.parse(filter_json) as WatchlistFilter })),
  });
});

// One transaction: the list's deliveries rows (guarded by the key), then the list.
watchlists.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const keyId = c.var.apiKey.id;
  const [, res] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM deliveries WHERE watchlist_id IN (SELECT id FROM watchlists WHERE id = ? AND key_id = ?)").bind(id, keyId),
    c.env.DB.prepare("DELETE FROM watchlists WHERE id = ? AND key_id = ?").bind(id, keyId),
  ]);
  if (res.meta.changes === 0) return answer(c, { error: "not found" }, 404);
  return c.body(null, 204);
});

interface DeliveryListRow {
  advisory_id: string;
  cursor: number;
  status: string;
  attempt: number;
  last_code: number | null;
  next_at: string;
  delivered_at: string | null;
}

// The newest deliveries of one list, by cursor, with status. next_at is the
// next attempt time, so it is shown for pending rows only.
watchlists.get("/:id/deliveries", async (c) => {
  const id = c.req.param("id");
  const keyId = c.var.apiKey.id;
  const [list, limitRaw] = await Promise.all([
    c.env.DB.prepare("SELECT 1 AS x FROM watchlists WHERE id = ? AND key_id = ?").bind(id, keyId).first(),
    getSettingInt(c.env.DB, "webhooks.deliveries_list_limit", FALLBACK_DELIVERIES_LIST_LIMIT),
  ]);
  if (!list) return answer(c, { error: "not found" }, 404);
  const limit = Math.min(Math.max(limitRaw, 1), DELIVERIES_LIST_MAX);
  const { results } = await c.env.DB.prepare(DELIVERIES_LIST_SQL).bind(id, keyId, limit).all<DeliveryListRow>();
  return answer(c, {
    deliveries: results.map(({ next_at, ...r }) => ({ ...r, next_at: r.status === "pending" ? next_at : null })),
  });
});

// Events from the list's stored cursor. Without peek=true the stored cursor
// moves to next_cursor BEFORE the answer is sent; a failed update answers 500
// and no events. The cursor never moves backward.
watchlists.get("/:id/events", async (c) => {
  const q = new URL(c.req.url).searchParams;
  const limitRaw = q.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_LIMIT) {
      return answer(c, { error: `limit must be an integer from 1 to ${MAX_LIMIT}` }, 400);
    }
    limit = Number(limitRaw);
  }
  const peekRaw = q.get("peek");
  if (peekRaw !== null && peekRaw !== "true" && peekRaw !== "false") return answer(c, { error: "peek must be true or false" }, 400);
  const peek = peekRaw === "true";

  const id = c.req.param("id");
  const keyId = c.var.apiKey.id;
  const list = await c.env.DB.prepare("SELECT filter_json, cursor FROM watchlists WHERE id = ? AND key_id = ?")
    .bind(id, keyId)
    .first<{ filter_json: string; cursor: number }>();
  if (!list) return answer(c, { error: "not found" }, 404);

  const { sql, params } = buildWatchlistEventsQuery(JSON.parse(list.filter_json) as WatchlistFilter, list.cursor, limit);
  const { results } = await c.env.DB.prepare(sql)
    .bind(...params)
    .all<{ cursor: number; doc_json: string }>();
  const has_more = results.length > limit;
  const page = has_more ? results.slice(0, limit) : results;
  const next_cursor = page.length ? page[page.length - 1].cursor : list.cursor;

  if (!peek && page.length) {
    await c.env.DB.prepare("UPDATE watchlists SET cursor = MAX(cursor, ?) WHERE id = ? AND key_id = ?").bind(next_cursor, id, keyId).run();
  }
  return answer(c, { events: page.map((r) => JSON.parse(r.doc_json)), next_cursor, has_more });
});

export default watchlists;
