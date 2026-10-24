import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { renderConfirmPage, renderKeyPage, renderLinkGonePage } from "../../site/keys";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";
import { getSettingText } from "../lib/settings-text";
import { noteDkimUnsigned, resolveDkim } from "../mail/dkim";
import { getMailer } from "../mail/send";
import { refundSend, reserveSend } from "../mail/send-caps";
import { sha256Hex, toHex } from "../middleware/auth";
import { keysRateLimit } from "../middleware/ratelimit";

const NO_STORE = { "Cache-Control": "no-store" };
// Pages of the mailed link: never cached, never framed, never indexed, and the
// token in the URL never leaves in a Referer header.
const PAGE_HEADERS = {
  ...NO_STORE,
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; form-action 'self'",
  "X-Robots-Tag": "noindex",
};
// Shape check only: one @, a dot in the domain, no spaces. 254 is the
// RFC 5321 address length limit, a protocol fact and not a knob.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
const TOKEN_RE = /^tct_[0-9a-f]{64}$/;
// Code fallbacks only. The live values are the settings rows named on each line.
export const FALLBACK_MAX_BODY_BYTES = 4096; // keys.max_body_bytes
export const FALLBACK_CONFIRM_TTL_SECONDS = 3600; // keys.confirm_ttl_seconds
export const FALLBACK_IP_SENDS_PER_HOUR = 10; // keys.ip_sends_per_hour
export const FALLBACK_EMAIL_SENDS_PER_HOUR = 3; // keys.email_sends_per_hour
export const FALLBACK_DAILY_SEND_CAP = 500; // mail.daily_send_cap
export const FALLBACK_MAIL_PROVIDER = "mailchannels"; // mail.provider
export const FALLBACK_FROM_ADDRESS = "keys@tocsin.sh"; // mail.from_address
export const FALLBACK_CONFIRM_BASE_URL = "https://tocsin.sh"; // keys.confirm_base_url
// "" = not set: the mail goes out unsigned (src/mail/dkim.ts). The rows are seeded by migration 0030.
export const FALLBACK_DKIM_DOMAIN = ""; // mail.dkim_domain
export const FALLBACK_DKIM_SELECTOR = ""; // mail.dkim_selector
// KV refuses a TTL under 60 seconds: a platform fact, not a knob.
const KV_MIN_TTL_SECONDS = 60;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// api_keys statements of the confirm flow. All three use idx_api_keys_email
// (tests/routes/keys-plan.tcs-64.test.ts).
export const KEY_HASH_BY_EMAIL_SQL = "SELECT key_hash FROM api_keys WHERE email = ?";
export const CONFIRM_CREATE_SQL = `INSERT INTO api_keys (id, key_hash, email, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(email) DO NOTHING RETURNING id, plan`;
// Compare-and-swap: the hash moves only if it is still the one seen at send
// time, so a link is good once even though the KV token store is not atomic.
export const CONFIRM_ROTATE_SQL = "UPDATE api_keys SET key_hash = ?, last_used_at = ? WHERE email = ? AND key_hash = ? RETURNING id, plan";

const MAIL_SUBJECT = "Your Tocsin API key link";
const GONE = { error: "this link is used or expired; request a new one with POST /v1/keys" };

type Purpose = "create" | "rotate";
interface PendingToken {
  email: string;
  purpose: Purpose;
  // api_keys.key_hash of the email when the link was sent; null when it had no key.
  expect_hash: string | null;
  expires_at: number;
}
type Ctx = Context<{ Bindings: Env }>;

const tokenKey = (hash: string) => `keyconfirm:v1:${hash}`;

function mailText(link: string, minutes: number, replaces: boolean): string {
  return replaces
    ? `To replace the API key for this email, open the link and press Confirm within ${minutes} minutes. The old key stops working when you press Confirm: ${link}\n\nIf you did not ask for this, ignore this email. Opening the link alone changes nothing.`
    : `Use this link to get your Tocsin API key: open the link and press Confirm within ${minutes} minutes. ${link}\n\nIf you did not ask for a key, ignore this email.`;
}

function logError(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ lane: "mail", ...fields }));
}

// POST /v1/keys and POST /v1/keys/rotate. The answer never depends on whether
// the email has a key: 202 with one fixed body, or a refusal that is the same
// for every email. A registered email always gets a replace link.
async function sendConfirmLink(c: Ctx, purpose: Purpose): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonUtf8(c, { error: "body must be JSON: {\"email\": \"you@example.com\"}" }, 400, NO_STORE);
  }
  const raw = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as { email?: unknown }).email : undefined;
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    return jsonUtf8(c, { error: "email must be an address like you@example.com" }, 400, NO_STORE);
  }

  const now = Date.now();
  const hour = Math.floor(now / HOUR_MS);
  const day = new Date(now).toISOString().slice(0, 10);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  // The send_counters windows (src/mail/send-caps.ts).
  const windows = { ip: `ip:${ip}:${hour}`, email: `em:${await sha256Hex(email)}:${hour}`, day: `day:${day}` };
  const db = c.env.DB;
  const kv = c.env.CURSORS;

  const [ttlRaw, ipCap, emailCap, dayCap, provider, from, baseUrl, dkimDomain, dkimSelector] = await Promise.all([
    getSettingInt(db, "keys.confirm_ttl_seconds", FALLBACK_CONFIRM_TTL_SECONDS),
    getSettingInt(db, "keys.ip_sends_per_hour", FALLBACK_IP_SENDS_PER_HOUR),
    getSettingInt(db, "keys.email_sends_per_hour", FALLBACK_EMAIL_SENDS_PER_HOUR),
    getSettingInt(db, "mail.daily_send_cap", FALLBACK_DAILY_SEND_CAP),
    getSettingText(db, "mail.provider", FALLBACK_MAIL_PROVIDER),
    getSettingText(db, "mail.from_address", FALLBACK_FROM_ADDRESS),
    getSettingText(db, "keys.confirm_base_url", FALLBACK_CONFIRM_BASE_URL),
    getSettingText(db, "mail.dkim_domain", FALLBACK_DKIM_DOMAIN),
    getSettingText(db, "mail.dkim_selector", FALLBACK_DKIM_SELECTOR),
  ]);
  const ttl = Math.max(KV_MIN_TTL_SECONDS, ttlRaw);

  // The same value builds the mailer and the Tocsin-Mail-Dkim header, so the header is what was sent.
  const dkim = resolveDkim(c.env.DKIM_PRIVATE_KEY, dkimDomain, dkimSelector);
  const mailer = getMailer(c.env, provider, dkim.state === "signed" ? dkim.config : null);
  if (!mailer) {
    logError({ alert: "mail_not_configured", provider });
    return jsonUtf8(c, { error: "key sign-up is not available right now" }, 503, NO_STORE);
  }

  // Dedup before spend: the three caps are reserved in D1, in one
  // transaction, before the metered send. A refusal reserves nothing.
  const reserve = await reserveSend(db, windows, { ip: ipCap, email: emailCap, day: dayCap }, new Date(now).toISOString());
  if (!reserve.reserved) {
    if (reserve.ipOrEmailFull) {
      const retryAfter = Math.max(1, Math.ceil(((hour + 1) * HOUR_MS - now) / 1000));
      return jsonUtf8(c, { error: "rate limited" }, 429, { ...NO_STORE, "Retry-After": String(retryAfter) });
    }
    if (reserve.dayFull) logError({ alert: "daily_send_cap_hit", sent: reserve.daySent, cap: dayCap });
    const retryAfter = Math.max(1, Math.ceil(((Math.floor(now / DAY_MS) + 1) * DAY_MS - now) / 1000));
    return jsonUtf8(c, { error: "key sign-up is not available right now" }, 503, { ...NO_STORE, "Retry-After": String(retryAfter) });
  }

  const existing = await db.prepare(KEY_HASH_BY_EMAIL_SQL).bind(email).first<{ key_hash: string }>();
  const token = "tct_" + toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  const pending: PendingToken = { email, purpose, expect_hash: existing?.key_hash ?? null, expires_at: now + ttl * 1000 };
  // Token before send, so a link that went out always has its token.
  await kv.put(tokenKey(tokenHash), JSON.stringify(pending), { expirationTtl: ttl });

  const link = `${baseUrl.replace(/\/+$/, "")}/v1/keys/confirm?token=${token}`;
  try {
    await mailer.send({ to: email, from, subject: MAIL_SUBJECT, text: mailText(link, Math.round(ttl / 60), existing !== null) });
  } catch (err) {
    await kv.delete(tokenKey(tokenHash)).catch(() => undefined);
    // The mail did not go out, so its three slots go back.
    await refundSend(db, windows);
    logError({
      err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      status: (err as { status?: unknown }).status ?? null,
    });
    return jsonUtf8(c, { error: "could not send the email, try again" }, 502, NO_STORE);
  }

  // Only a mail that went out writes the unsigned warning (a 502 above writes none).
  if (dkim.state !== "signed") await noteDkimUnsigned(db, dkim.missing, new Date().toISOString());
  return jsonUtf8(c, { status: "sent", expires_in_seconds: ttl }, 202, { ...NO_STORE, "Tocsin-Mail-Dkim": dkim.state });
}

const keys = new Hono<{ Bindings: Env }>();

keys.use("*", keysRateLimit);

async function capBody(c: Ctx, next: () => Promise<void>) {
  const maxSize = await getSettingInt(c.env.DB, "keys.max_body_bytes", FALLBACK_MAX_BODY_BYTES);
  return bodyLimit({ maxSize, onError: (c) => jsonUtf8(c, { error: `body over ${maxSize} bytes` }, 413, NO_STORE) })(c, next);
}

// No key in this answer: the key is shown only after the mailed link is opened and Confirm is pressed.
keys.post("/", capBody, (c) => sendConfirmLink(c, "create"));
// Re-issue: confirming the link replaces the key of this email in place.
keys.post("/rotate", capBody, (c) => sendConfirmLink(c, "rotate"));

// The pending token of a well-formed, live, unexpired link, or null. Reads only.
async function readPending(kv: KVNamespace, token: string, now: number): Promise<PendingToken | null> {
  if (!TOKEN_RE.test(token)) return null;
  const raw = await kv.get(tokenKey(await sha256Hex(token)));
  if (raw === null) return null;
  const pending = JSON.parse(raw) as PendingToken;
  return pending.expires_at > now ? pending : null;
}

interface Issued {
  key: string;
  key_id: string;
  plan: string;
  email: string;
  replaced: boolean;
}

// Spends a token once. The KV token is deleted before the D1 write, and the
// D1 write is a compare-and-swap, so two presses give one key and one null.
async function consume(env: Env, token: string): Promise<Issued | null> {
  const kvKey = tokenKey(await sha256Hex(token));
  const raw = await env.CURSORS.get(kvKey);
  if (raw === null) return null;
  await env.CURSORS.delete(kvKey);
  const pending = JSON.parse(raw) as PendingToken;
  const now = Date.now();
  if (pending.expires_at <= now) return null;
  const key = "tcs_" + toHex(crypto.getRandomValues(new Uint8Array(32)));
  const keyHash = await sha256Hex(key);
  const nowIso = new Date(now).toISOString();
  const row =
    pending.expect_hash === null
      ? await env.DB.prepare(CONFIRM_CREATE_SQL).bind("key_" + crypto.randomUUID(), keyHash, pending.email, nowIso, nowIso).first<{ id: string; plan: string }>()
      : await env.DB.prepare(CONFIRM_ROTATE_SQL).bind(keyHash, nowIso, pending.email, pending.expect_hash).first<{ id: string; plan: string }>();
  return row ? { key, key_id: row.id, plan: row.plan, email: pending.email, replaced: pending.expect_hash !== null } : null;
}

// The token from a form post (the Confirm button) or a JSON body (an agent).
async function readTokenBody(c: Ctx): Promise<{ token: string; form: boolean } | null> {
  const type = c.req.header("Content-Type") ?? "";
  if (type.startsWith("application/x-www-form-urlencoded")) {
    const raw = (await c.req.parseBody())["token"];
    return { token: typeof raw === "string" ? raw : "", form: true };
  }
  try {
    const body: unknown = await c.req.json();
    const raw = body !== null && typeof body === "object" ? (body as { token?: unknown }).token : undefined;
    return { token: typeof raw === "string" ? raw : "", form: false };
  } catch {
    return null;
  }
}

// A browser sends Origin on a form post; a cross-site one is refused before
// the token is touched. A client with no Origin header (an agent) passes.
function crossOrigin(c: Ctx): boolean {
  const origin = c.req.header("Origin");
  return origin !== undefined && origin !== new URL(c.req.url).origin;
}

// GET shows the Confirm page and writes nothing: a mail scanner that opens
// the link spends no token and changes no key.
keys.get("/confirm", async (c) => {
  const token = c.req.query("token") ?? "";
  const pending = await readPending(c.env.CURSORS, token, Date.now());
  if (!pending) return c.html(renderLinkGonePage(), 410, PAGE_HEADERS);
  return c.html(renderConfirmPage(token, pending.expect_hash !== null), 200, PAGE_HEADERS);
});

// POST spends the token once and shows the key once; the same token again is 410.
keys.post("/confirm", capBody, async (c) => {
  if (crossOrigin(c)) return jsonUtf8(c, { error: "cross-origin confirm is not allowed" }, 403, NO_STORE);
  const input = await readTokenBody(c);
  if (!input || !TOKEN_RE.test(input.token)) {
    return jsonUtf8(c, { error: "token must be the tct_ value from the emailed link" }, 400, NO_STORE);
  }
  const issued = await consume(c.env, input.token);
  if (input.form) {
    return issued ? c.html(renderKeyPage(issued.key, issued.replaced), 200, PAGE_HEADERS) : c.html(renderLinkGonePage(), 410, PAGE_HEADERS);
  }
  if (!issued) return jsonUtf8(c, GONE, 410, NO_STORE);
  return jsonUtf8(c, { key: issued.key, key_id: issued.key_id, plan: issued.plan, email: issued.email }, 200, NO_STORE);
});

export default keys;
