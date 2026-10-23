import type { Env } from "../env";
import { getSettingInt, getSettingIntList } from "../lib/settings";
import type { DeliveryMessage } from "./enqueue";
import { eventId, signBody } from "./sign";

// Code fallbacks only. The live values are the settings rows
// webhooks.backoff_seconds, webhooks.timeout_ms and webhooks.lease_seconds
// (migrations/0017_deliveries.sql).
export const FALLBACK_BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200];
export const FALLBACK_TIMEOUT_MS = 10_000;
export const FALLBACK_LEASE_SECONDS = 60;
// Cloudflare Queues accepts a delaySeconds of at most 12 hours. This is a
// platform limit, not a knob. A longer backoff keeps its real next_at; the
// early message is a no-op claim and the sweep sends the row when it is due.
export const QUEUE_MAX_DELAY_SECONDS = 43_200;

// The claim. A pending row that is due, or a sending row whose lease ended,
// moves to sending with a new lease. No row back: delivered, failed, skipped,
// not due yet, or another consumer holds it, so no HTTP call is made.
export const CLAIM_SQL = `UPDATE deliveries SET status = 'sending', next_at = ?
  WHERE watchlist_id = ? AND advisory_id = ? AND status IN ('pending', 'sending') AND next_at <= ?
  RETURNING attempt`;

export const LOAD_SQL = `SELECT w.webhook_url, w.webhook_secret, w.delivery, a.doc_json
  FROM deliveries d JOIN watchlists w ON w.id = d.watchlist_id JOIN advisories a ON a.id = d.advisory_id
  WHERE d.watchlist_id = ? AND d.advisory_id = ?`;

// Every result write is guarded by the lease this consumer took, so a
// consumer whose lease ran out never overwrites a newer claim.
const RESULT_GUARD = "WHERE watchlist_id = ? AND advisory_id = ? AND status = 'sending' AND next_at = ?";

export interface QueueDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
}

const defaultDeps: QueueDeps = { fetch: (input, init) => fetch(input, init), now: () => new Date() };

interface Knobs {
  backoff: number[];
  timeoutMs: number;
  leaseSeconds: number;
}

function isMessage(b: unknown): b is DeliveryMessage {
  if (b === null || typeof b !== "object") return false;
  const m = b as Record<string, unknown>;
  return typeof m.watchlist_id === "string" && m.watchlist_id !== "" && typeof m.advisory_id === "string" && m.advisory_id !== "";
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

type Outcome = "bad_body" | "not_claimed" | "not_configured" | "delivered" | "retry" | "failed";

async function deliverOne(body: unknown, env: Env, deps: QueueDeps, k: Knobs): Promise<Outcome> {
  if (!isMessage(body)) {
    console.error(JSON.stringify({ lane: "queue", err: "malformed message body, dropped" }));
    return "bad_body";
  }
  const { watchlist_id, advisory_id } = body;
  const now = deps.now();
  const nowIso = now.toISOString();
  const lease = new Date(now.getTime() + k.leaseSeconds * 1000).toISOString();

  const claimed = await env.DB.prepare(CLAIM_SQL).bind(lease, watchlist_id, advisory_id, nowIso).first<{ attempt: number }>();
  if (!claimed) return "not_claimed";

  const target = await env.DB.prepare(LOAD_SQL)
    .bind(watchlist_id, advisory_id)
    .first<{ webhook_url: string | null; webhook_secret: string | null; delivery: string; doc_json: string }>();
  if (!target || target.delivery !== "webhook" || !target.webhook_url || !target.webhook_secret) {
    await env.DB.prepare(`UPDATE deliveries SET status = 'failed', next_at = ?, last_code = NULL ${RESULT_GUARD}`)
      .bind(nowIso, watchlist_id, advisory_id, lease)
      .run();
    console.log(JSON.stringify({ lane: "queue", watchlist_id, advisory_id, outcome: "failed", reason: "list missing or not a webhook list" }));
    return "not_configured";
  }

  const payload = target.doc_json;
  let code: number | null = null;
  try {
    const res = await deps.fetch(target.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "tocsin-webhooks",
        "Tocsin-Event-Id": eventId(watchlist_id, advisory_id),
        "Tocsin-Timestamp": String(Math.floor(now.getTime() / 1000)),
        "Tocsin-Signature": await signBody(target.webhook_secret, payload),
      },
      body: payload,
      // A 3xx is a failure: a signed body never follows a redirect to another host.
      redirect: "manual",
      signal: AbortSignal.timeout(k.timeoutMs),
    });
    code = res.status;
    // Free the connection; the receiver's answer body is not used.
    await res.body?.cancel();
  } catch (err) {
    console.log(JSON.stringify({ lane: "queue", watchlist_id, advisory_id, err: `POST failed: ${errText(err)}` }));
  }

  const done = deps.now().toISOString();
  if (code !== null && code >= 200 && code < 300) {
    await env.DB.prepare(`UPDATE deliveries SET status = 'delivered', delivered_at = ?, last_code = ?, attempt = attempt + 1 ${RESULT_GUARD}`)
      .bind(done, code, watchlist_id, advisory_id, lease)
      .run();
    return "delivered";
  }

  const attempts = claimed.attempt + 1;
  if (attempts > k.backoff.length) {
    await env.DB.prepare(`UPDATE deliveries SET status = 'failed', next_at = ?, last_code = ?, attempt = attempt + 1 ${RESULT_GUARD}`)
      .bind(done, code, watchlist_id, advisory_id, lease)
      .run();
    console.log(JSON.stringify({ lane: "queue", watchlist_id, advisory_id, outcome: "failed", attempts, last_code: code }));
    return "failed";
  }
  const delay = k.backoff[attempts - 1];
  const nextAt = new Date(now.getTime() + delay * 1000).toISOString();
  const w = await env.DB.prepare(`UPDATE deliveries SET status = 'pending', next_at = ?, last_code = ?, attempt = attempt + 1 ${RESULT_GUARD}`)
    .bind(nextAt, code, watchlist_id, advisory_id, lease)
    .run();
  if (w.meta.changes === 0) return "retry";
  let delaySeconds = delay;
  if (delaySeconds > QUEUE_MAX_DELAY_SECONDS) {
    console.log(JSON.stringify({ lane: "queue", watchlist_id, advisory_id, note: `backoff ${delay}s is over the queue maximum, message delayed ${QUEUE_MAX_DELAY_SECONDS}s` }));
    delaySeconds = QUEUE_MAX_DELAY_SECONDS;
  }
  try {
    await env.DELIVERIES.send({ watchlist_id, advisory_id }, { delaySeconds });
  } catch (err) {
    console.error(JSON.stringify({ lane: "queue", watchlist_id, advisory_id, err: `retry send failed, the sweep re-sends: ${errText(err)}` }));
  }
  return "retry";
}

// The webhook consumer of the deliveries queue. Each message is one
// (watchlist_id, advisory_id) pair. The claim row write comes BEFORE the POST,
// and 'delivered' is written only after a 2xx is in hand. Every handled
// message is acked: retries are our own delayed messages, never msg.retry(),
// so the queue's own retry limit never drops a row. An unexpected throw leaves
// the row pending or sending and asks the queue to retry the message.
export async function runQueue(batch: MessageBatch, env: Env, _ctx: ExecutionContext, deps: QueueDeps = defaultDeps): Promise<void> {
  const [backoff, timeoutMs, leaseSeconds] = await Promise.all([
    getSettingIntList(env.DB, "webhooks.backoff_seconds", FALLBACK_BACKOFF_SECONDS),
    getSettingInt(env.DB, "webhooks.timeout_ms", FALLBACK_TIMEOUT_MS),
    getSettingInt(env.DB, "webhooks.lease_seconds", FALLBACK_LEASE_SECONDS),
  ]);
  const k: Knobs = { backoff, timeoutMs: timeoutMs > 0 ? timeoutMs : FALLBACK_TIMEOUT_MS, leaseSeconds: leaseSeconds > 0 ? leaseSeconds : FALLBACK_LEASE_SECONDS };

  // Each message is a different primary key, so the messages share no row.
  const outcomes = await Promise.all(
    batch.messages.map(async (msg) => {
      try {
        const o = await deliverOne(msg.body, env, deps, k);
        msg.ack();
        return o;
      } catch (err) {
        console.error(JSON.stringify({ lane: "queue", body: isMessage(msg.body) ? msg.body : null, err: errText(err) }));
        msg.retry();
        return "error" as const;
      }
    }),
  );
  const counts: Record<string, number> = {};
  for (const o of outcomes) counts[o] = (counts[o] ?? 0) + 1;
  console.log(JSON.stringify({ lane: "queue", queue: batch.queue, size: batch.messages.length, ...counts }));
}
