import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../feed/query";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";
import { requireApiKey, type AuthEnv } from "../middleware/auth";
import { keyRateLimit } from "../middleware/ratelimit";
import { parseWatchlistBody, type WatchlistFilter } from "../watchlists/filter";
import { buildWatchlistEventsQuery } from "../watchlists/query";

// Code fallback only. The live cap is settings.watchlists.max_body_bytes.
export const FALLBACK_MAX_BODY_BYTES = 1_048_576;

// One guarded statement: the count check and the insert are atomic, so two
// parallel creates cannot pass plans.max_watchlists. A new list starts at the
// newest feed cursor, so it answers new events only.
export const CREATE_WATCHLIST_SQL = `INSERT INTO watchlists (id, key_id, name, filter_json, cursor, delivery, created_at)
  SELECT ?, ?, ?, ?, (SELECT COALESCE(MAX(cursor), 0) FROM advisories), 'poll', ?
  WHERE (SELECT COUNT(*) FROM watchlists WHERE key_id = ?) < ?
  RETURNING cursor`;

// LIMIT is plans.max_watchlists, so the answer is at most that many lists of
// at most MAX_FILTER_BYTES each. Never selects webhook_secret.
export const LIST_WATCHLISTS_SQL =
  "SELECT id, name, filter_json, cursor, delivery, created_at FROM watchlists WHERE key_id = ? ORDER BY created_at, id LIMIT ?";

const NO_STORE = { "Cache-Control": "no-store" };

type Ctx = Context<AuthEnv>;
const answer = (c: Ctx, body: unknown, status: ContentfulStatusCode = 200) => jsonUtf8(c, body, status, NO_STORE);

interface ListRow {
  id: string;
  name: string;
  filter_json: string;
  cursor: number;
  delivery: string;
  created_at: string;
}

const watchlists = new Hono<AuthEnv>();

// Auth first, so the per-key counter has a key id; an unknown key is 401 and
// is never counted.
watchlists.use("*", requireApiKey, keyRateLimit);

watchlists.post(
  "/",
  async (c, next) => {
    const maxSize = await getSettingInt(c.env.DB, "watchlists.max_body_bytes", FALLBACK_MAX_BODY_BYTES);
    return bodyLimit({ maxSize, onError: (c) => answer(c, { error: `body over ${maxSize} bytes` }, 413) })(c, next);
  },
  async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return answer(c, { error: "body must be JSON" }, 400);
    }
    const parsed = parseWatchlistBody(body);
    if (!parsed.ok) return answer(c, { error: parsed.error }, 400);

    const { id: keyId, limits } = c.var.apiKey;
    if (parsed.filter.components.length > limits.max_components) {
      return answer(c, { error: "component limit reached", max_components: limits.max_components }, 403);
    }

    const id = "wl_" + crypto.randomUUID();
    const created_at = new Date().toISOString();
    const row = await c.env.DB.prepare(CREATE_WATCHLIST_SQL)
      .bind(id, keyId, parsed.name, JSON.stringify(parsed.filter), created_at, keyId, limits.max_watchlists)
      .first<{ cursor: number }>();
    if (!row) return answer(c, { error: "watch list limit reached", max_watchlists: limits.max_watchlists }, 403);

    return answer(c, { id, name: parsed.name, filter: parsed.filter, cursor: row.cursor, delivery: "poll", created_at }, 201);
  },
);

watchlists.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(LIST_WATCHLISTS_SQL).bind(c.var.apiKey.id, c.var.apiKey.limits.max_watchlists).all<ListRow>();
  return answer(c, {
    watchlists: results.map(({ filter_json, ...r }) => ({ ...r, filter: JSON.parse(filter_json) as WatchlistFilter })),
  });
});

watchlists.delete("/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM watchlists WHERE id = ? AND key_id = ?").bind(c.req.param("id"), c.var.apiKey.id).run();
  if (res.meta.changes === 0) return answer(c, { error: "not found" }, 404);
  return c.body(null, 204);
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
