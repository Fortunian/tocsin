import type { Env } from "../env";
import { decryptSecret, loadKek } from "../lib/secret-box";
import { getSettingInt, getSettingIntList } from "../lib/settings";
import { checkWebhookUrl } from "../watchlists/webhook-url";
import type { DeliveryMessage } from "./enqueue";
import { FALLBACK_DNS_CACHE_SECONDS, checkHost } from "./resolve";
import { eventId, signatureHeaders } from "./sign";

// Code fallbacks only. The live values are the settings rows
// webhooks.backoff_seconds, webhooks.timeout_ms, webhooks.lease_seconds
// (migrations/0021_deliveries.sql), webhooks.pause_after_failures and
// webhooks.dns_cache_seconds (migrations/0023_watchlist_delivery_health.sql,
// 0027_dns_cache_seconds.sql).
export const FALLBACK_BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200];
export const FALLBACK_TIMEOUT_MS = 10_000;
export const FALLBACK_LEASE_SECONDS = 60;
export const FALLBACK_PAUSE_AFTER_FAILURES = 10;
// Cloudflare Queues accepts a delaySeconds of at most 12 hours. This is a
// platform limit, not a knob. A longer backoff keeps its real next_at; the
// early message is a no-op claim and the sweep sends the row when it is due.
export const QUEUE_MAX_DELAY_SECONDS = 43_200;

// The dead-letter queue of the deliveries consumer (wrangler.toml). The queue
// moves a message here after max_retries throws of the consumer.
export const DLQ_QUEUE = "deliveries-dlq";

// The claim. A pending row that is due, or a sending row whose lease ended,
// moves to sending with a new lease. No row back: delivered, failed, skipped,
// not due yet, another consumer holds it, or the list is paused (its rows
// stay as they are, so a pause burns no attempt). No HTTP call is made then.
export const CLAIM_SQL = `UPDATE deliveries SET status = 'sending', next_at = ?
  WHERE watchlist_id = ? AND advisory_id = ? AND status IN ('pending', 'sending') AND next_at <= ?
    AND NOT EXISTS (SELECT 1 FROM watchlists w WHERE w.id = deliveries.watchlist_id AND w.paused_at IS NOT NULL)
  RETURNING attempt`;

// affected_json is set on rows of the dependency match pass (TCS-37).
export const LOAD_SQL = `SELECT w.webhook_url, w.webhook_secret, w.webhook_secret_enc, w.delivery, a.doc_json, d.affected_json
  FROM deliveries d JOIN watchlists w ON w.id = d.watchlist_id JOIN advisories a ON a.id = d.advisory_id
  WHERE d.watchlist_id = ? AND d.advisory_id = ?`;

// Every result write is guarded by the lease this consumer took, so a
// consumer whose lease ran out never overwrites a newer claim.
const RESULT_GUARD = "WHERE watchlist_id = ? AND advisory_id = ? AND status = 'sending' AND next_at = ?";

// Delivery health of the list (migrations/0023). A 2xx resets the counter. A
// failed attempt adds 1 and sets paused_at when the count reaches ?3.
export const HEALTH_OK_SQL = "UPDATE watchlists SET consecutive_failures = 0, last_delivery_at = ?1, last_delivery_code = ?2 WHERE id = ?3";
// A dead-lettered message: its row becomes failed with the reason, from
// pending or sending only. A delivered, failed or skipped row is never changed.
export const DEAD_LETTER_SQL = `UPDATE deliveries SET status = 'failed', next_at = ?, last_error = 'dead_letter'
  WHERE watchlist_id = ? AND advisory_id = ? AND status IN ('pending', 'sending')`;

export const HEALTH_FAIL_SQL = `UPDATE watchlists SET consecutive_failures = consecutive_failures + 1, last_delivery_at = ?1, last_delivery_code = ?2,
  paused_at = CASE WHEN paused_at IS NULL AND consecutive_failures + 1 >= ?3 THEN ?1 ELSE paused_at END
  WHERE id = ?4 RETURNING consecutive_failures, paused_at`;

export interface QueueDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
}

const defaultDeps: QueueDeps = { fetch: (input, init) => fetch(input, init), now: () => new Date() };

interface Knobs {
  backoff: number[];
  timeoutMs: number;
  leaseSeconds: number;
  pauseAfter: number;
  dnsTtl: number;
  // Set when the knobs break an invariant; the batch then makes no claim.
  refuse: string | null;
}

// The KEK, imported at most once per batch and only when a row needs it.
type KekSource = () => Promise<CryptoKey | null>;

// One claimed delivery: what every result write needs.
interface Job {
  env: Env;
  kek: KekSource;
  deps: QueueDeps;
  k: Knobs;
  watchlist_id: string;
  advisory_id: string;
  now: Date;
  lease: string;
  attempt: number;
}

interface Target {
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_secret_enc: string | null;
  delivery: string;
  doc_json: string;
  affected_json: string | null;
}

// The result of one attempt: an HTTP status, or no answer and why.
interface Attempt {
  code: number | null;
  error: string | null;
}

function isMessage(b: unknown): b is DeliveryMessage {
  if (b === null || typeof b !== "object") return false;
  const m = b as Record<string, unknown>;
  return typeof m.watchlist_id === "string" && m.watchlist_id !== "" && typeof m.advisory_id === "string" && m.advisory_id !== "";
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function log(j: Job, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ lane: "queue", watchlist_id: j.watchlist_id, advisory_id: j.advisory_id, ...fields }));
}

type Outcome = "bad_body" | "not_claimed" | "not_configured" | "delivered" | "retry" | "failed";

// Updates the list's health after a result write that held the lease.
async function recordHealth(j: Job, a: Attempt, at: string): Promise<void> {
  if (a.code !== null && a.code >= 200 && a.code < 300) {
    await j.env.DB.prepare(HEALTH_OK_SQL).bind(at, a.code, j.watchlist_id).run();
    return;
  }
  const h = await j.env.DB.prepare(HEALTH_FAIL_SQL).bind(at, a.code, j.k.pauseAfter, j.watchlist_id).first<{ consecutive_failures: number; paused_at: string | null }>();
  if (h && h.paused_at === at) log(j, { outcome: "paused", consecutive_failures: h.consecutive_failures });
}

// A terminal failure: the row is failed and is never sent again.
async function finishFailed(j: Job, a: Attempt): Promise<Outcome> {
  const done = j.deps.now().toISOString();
  const w = await j.env.DB.prepare(`UPDATE deliveries SET status = 'failed', next_at = ?, last_code = ?, last_error = ?, attempt = attempt + 1 ${RESULT_GUARD}`)
    .bind(done, a.code, a.error, j.watchlist_id, j.advisory_id, j.lease)
    .run();
  if (w.meta.changes > 0) await recordHealth(j, a, done);
  log(j, { outcome: "failed", attempts: j.attempt + 1, last_code: a.code, last_error: a.error });
  return "failed";
}

async function finishDelivered(j: Job, a: Attempt): Promise<Outcome> {
  const done = j.deps.now().toISOString();
  const w = await j.env.DB.prepare(`UPDATE deliveries SET status = 'delivered', delivered_at = ?, last_code = ?, last_error = NULL, attempt = attempt + 1 ${RESULT_GUARD}`)
    .bind(done, a.code, j.watchlist_id, j.advisory_id, j.lease)
    .run();
  if (w.meta.changes > 0) await recordHealth(j, a, done);
  return "delivered";
}

// A failed attempt with attempts left: back to pending at the next backoff,
// with one delayed queue message. The last attempt is a terminal failure.
async function scheduleRetry(j: Job, a: Attempt): Promise<Outcome> {
  const attempts = j.attempt + 1;
  if (attempts > j.k.backoff.length) return finishFailed(j, a);
  const delay = j.k.backoff[attempts - 1];
  const nextAt = new Date(j.now.getTime() + delay * 1000).toISOString();
  const w = await j.env.DB.prepare(`UPDATE deliveries SET status = 'pending', next_at = ?, last_code = ?, last_error = ?, attempt = attempt + 1 ${RESULT_GUARD}`)
    .bind(nextAt, a.code, a.error, j.watchlist_id, j.advisory_id, j.lease)
    .run();
  if (w.meta.changes === 0) return "retry";
  await recordHealth(j, a, j.deps.now().toISOString());
  await sendRetry(j, delay);
  return "retry";
}

async function sendRetry(j: Job, delay: number): Promise<void> {
  let delaySeconds = delay;
  if (delaySeconds > QUEUE_MAX_DELAY_SECONDS) {
    log(j, { note: `backoff ${delay}s is over the queue maximum, message delayed ${QUEUE_MAX_DELAY_SECONDS}s` });
    delaySeconds = QUEUE_MAX_DELAY_SECONDS;
  }
  try {
    await j.env.DELIVERIES.send({ watchlist_id: j.watchlist_id, advisory_id: j.advisory_id }, { delaySeconds });
  } catch (err) {
    console.error(JSON.stringify({ lane: "queue", watchlist_id: j.watchlist_id, advisory_id: j.advisory_id, err: `retry send failed, the sweep re-sends: ${errText(err)}` }));
  }
}

// The signed POST. A 3xx is a failure: a signed body never follows a redirect.
async function post(j: Job, url: string, secret: string, payload: string): Promise<Attempt> {
  try {
    const res = await j.deps.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "tocsin-webhooks",
        "Tocsin-Event-Id": eventId(j.watchlist_id, j.advisory_id),
        ...(await signatureHeaders(secret, payload, Math.floor(j.now.getTime() / 1000))),
      },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(j.k.timeoutMs),
    });
    // Free the connection; the receiver's answer body is not used.
    await res.body?.cancel();
    return { code: res.status, error: null };
  } catch (err) {
    log(j, { err: `POST failed: ${errText(err)}` });
    return { code: null, error: "network" };
  }
}

// The webhook body: the advisory document as stored, byte for byte, or for a
// dependency list (TCS-37) the advisory plus its affected items. The
// signature covers the bytes sent.
export function payloadOf(t: Pick<Target, "doc_json" | "affected_json">): string {
  if (t.affected_json === null) return t.doc_json;
  return JSON.stringify({ ...(JSON.parse(t.doc_json) as object), affected: JSON.parse(t.affected_json) as unknown });
}

// The SSRF guard at send time: the URL rules again (a stored URL can predate
// them), then the DNS answers. blocked_host is terminal; dns_failed retries.
async function guardAndSend(j: Job, t: Target & { webhook_url: string }, secret: string): Promise<Outcome> {
  const checked = checkWebhookUrl(t.webhook_url);
  if (!checked.ok) {
    log(j, { reason: checked.reason });
    return finishFailed(j, { code: null, error: "blocked_host" });
  }
  const verdict = await checkHost(j.env.CURSORS, j.deps.fetch, checked.host, j.k.dnsTtl);
  if (!verdict.ok) {
    log(j, { reason: verdict.reason, detail: verdict.detail });
    const a = { code: null, error: verdict.reason };
    return verdict.reason === "blocked_host" ? finishFailed(j, a) : scheduleRetry(j, a);
  }
  const a = await post(j, t.webhook_url, secret, payloadOf(t));
  return a.code !== null && a.code >= 200 && a.code < 300 ? finishDelivered(j, a) : scheduleRetry(j, a);
}

// The signing secret of a list: decrypted from webhook_secret_enc (only here,
// at sign time), else the plaintext of a row not moved yet. null when the
// ciphertext cannot be read (no KEK, a wrong KEK, a damaged value).
async function signingSecret(j: Job, t: Target): Promise<string | null> {
  if (t.webhook_secret_enc) {
    const kek = await j.kek();
    if (!kek) return null;
    try {
      return await decryptSecret(kek, j.watchlist_id, t.webhook_secret_enc);
    } catch (err) {
      log(j, { err: `decrypt failed: ${errText(err)}` });
      return null;
    }
  }
  return t.webhook_secret;
}

async function deliverOne(body: unknown, env: Env, deps: QueueDeps, k: Knobs, kek: KekSource): Promise<Outcome> {
  if (!isMessage(body)) {
    console.error(JSON.stringify({ lane: "queue", err: "malformed message body, dropped" }));
    return "bad_body";
  }
  const { watchlist_id, advisory_id } = body;
  const now = deps.now();
  const lease = new Date(now.getTime() + k.leaseSeconds * 1000).toISOString();

  const claimed = await env.DB.prepare(CLAIM_SQL).bind(lease, watchlist_id, advisory_id, now.toISOString()).first<{ attempt: number }>();
  if (!claimed) return "not_claimed";
  const j: Job = { env, kek, deps, k, watchlist_id, advisory_id, now, lease, attempt: claimed.attempt };

  const t = await env.DB.prepare(LOAD_SQL).bind(watchlist_id, advisory_id).first<Target>();
  if (!t || t.delivery !== "webhook" || !t.webhook_url || (!t.webhook_secret && !t.webhook_secret_enc)) {
    await env.DB.prepare(`UPDATE deliveries SET status = 'failed', next_at = ?, last_code = NULL ${RESULT_GUARD}`)
      .bind(now.toISOString(), watchlist_id, advisory_id, lease)
      .run();
    log(j, { outcome: "failed", reason: "list missing or not a webhook list" });
    return "not_configured";
  }
  const secret = await signingSecret(j, t);
  // A config error on our side: a retry does not fix it, and nothing is sent.
  if (secret === null) return finishFailed(j, { code: null, error: "secret_unreadable" });
  return guardAndSend(j, { ...t, webhook_url: t.webhook_url }, secret);
}

async function readKnobs(db: D1Database): Promise<Knobs> {
  const [backoff, timeoutMs, leaseSeconds, pauseAfter, dnsTtl] = await Promise.all([
    getSettingIntList(db, "webhooks.backoff_seconds", FALLBACK_BACKOFF_SECONDS),
    getSettingInt(db, "webhooks.timeout_ms", FALLBACK_TIMEOUT_MS),
    getSettingInt(db, "webhooks.lease_seconds", FALLBACK_LEASE_SECONDS),
    getSettingInt(db, "webhooks.pause_after_failures", FALLBACK_PAUSE_AFTER_FAILURES),
    getSettingInt(db, "webhooks.dns_cache_seconds", FALLBACK_DNS_CACHE_SECONDS),
  ]);
  const k: Knobs = {
    backoff,
    timeoutMs: timeoutMs > 0 ? timeoutMs : FALLBACK_TIMEOUT_MS,
    leaseSeconds: leaseSeconds > 0 ? leaseSeconds : FALLBACK_LEASE_SECONDS,
    pauseAfter: pauseAfter > 0 ? pauseAfter : FALLBACK_PAUSE_AFTER_FAILURES,
    // 0 is a valid value: no DNS cache, a lookup at every send.
    dnsTtl,
    refuse: null,
  };
  // A POST that can outlive its lease lets a second consumer claim the row
  // and send it again while the first is still waiting.
  if (k.timeoutMs >= k.leaseSeconds * 1000) {
    k.refuse = `invariant: webhooks.timeout_ms (${k.timeoutMs}) >= webhooks.lease_seconds * 1000 (${k.leaseSeconds * 1000}), refusing the batch`;
  }
  return k;
}

// The consumer of deliveries-dlq. Each message is one the deliveries consumer
// threw on max_retries times. Its row becomes failed with last_error
// dead_letter, so a throw is never silent. Logged as an error, never counted
// as a delivery. A throw here retries the DLQ message; the DLQ has no DLQ of
// its own, so the error log line is the record.
async function runDeadLetters(batch: MessageBatch, env: Env, deps: QueueDeps): Promise<void> {
  const at = deps.now().toISOString();
  let failed = 0;
  for (const msg of batch.messages) {
    if (!isMessage(msg.body)) {
      console.error(JSON.stringify({ lane: "dlq", err: "malformed message body, dropped", attempts: msg.attempts }));
      msg.ack();
      continue;
    }
    const { watchlist_id, advisory_id } = msg.body;
    try {
      const w = await env.DB.prepare(DEAD_LETTER_SQL).bind(at, watchlist_id, advisory_id).run();
      failed += w.meta.changes;
      console.error(JSON.stringify({ lane: "dlq", watchlist_id, advisory_id, attempts: msg.attempts, changed: w.meta.changes, err: "dead_letter: the consumer threw on every try" }));
      msg.ack();
    } catch (err) {
      console.error(JSON.stringify({ lane: "dlq", watchlist_id, advisory_id, err: errText(err) }));
      msg.retry();
    }
  }
  console.log(JSON.stringify({ lane: "dlq", size: batch.messages.length, failed }));
}

// The webhook consumer of the deliveries queue. Each message is one
// (watchlist_id, advisory_id) pair. The claim row write comes BEFORE the POST,
// and 'delivered' is written only after a 2xx is in hand. Every handled
// message is acked: retries are our own delayed messages, never msg.retry(),
// so the queue's own retry limit never drops a row. An unexpected throw leaves
// the row pending or sending and asks the queue to retry the message.
export async function runQueue(batch: MessageBatch, env: Env, _ctx: ExecutionContext, deps: QueueDeps = defaultDeps): Promise<void> {
  if (batch.queue === DLQ_QUEUE) return runDeadLetters(batch, env, deps);
  const k = await readKnobs(env.DB);
  if (k.refuse) {
    // 0 claims, 0 POSTs. The rows stay pending; the sweep sends them again
    // after webhooks.sweep_grace_seconds, once the knobs are fixed. Acked, so
    // the messages do not go to the DLQ and fail rows for a config typo.
    console.error(JSON.stringify({ lane: "queue", err: k.refuse, size: batch.messages.length }));
    for (const msg of batch.messages) msg.ack();
    return;
  }
  let kekP: Promise<CryptoKey | null> | null = null;
  const kek: KekSource = () => (kekP ??= loadKek(env, "queue"));

  // Each message is a different primary key, so the messages share no row.
  const outcomes = await Promise.all(
    batch.messages.map(async (msg) => {
      try {
        const o = await deliverOne(msg.body, env, deps, k, kek);
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
