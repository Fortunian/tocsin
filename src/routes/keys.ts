import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";
import { sha256Hex, toHex } from "../middleware/auth";
import { keysRateLimit } from "../middleware/ratelimit";

const NO_STORE = { "Cache-Control": "no-store" };
// Shape check only: one @, a dot in the domain, no spaces. 254 is the
// RFC 5321 address length limit, a protocol fact and not a knob.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
// Code fallback only. The live cap is settings.keys.max_body_bytes.
export const FALLBACK_MAX_BODY_BYTES = 4096;

const keys = new Hono<{ Bindings: Env }>();

keys.use("*", keysRateLimit);

// One key per email. The plaintext key is in this answer only; the row keeps
// its sha256. A second call for the same email answers 409 with no key.
keys.post(
  "/",
  async (c, next) => {
    const maxSize = await getSettingInt(c.env.DB, "keys.max_body_bytes", FALLBACK_MAX_BODY_BYTES);
    return bodyLimit({ maxSize, onError: (c) => jsonUtf8(c, { error: `body over ${maxSize} bytes` }, 413, NO_STORE) })(c, next);
  },
  async (c) => {
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

  const key = "tcs_" + toHex(crypto.getRandomValues(new Uint8Array(32)));
  const id = "key_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await c.env.DB.prepare(
    `INSERT INTO api_keys (id, key_hash, email, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO NOTHING RETURNING plan`,
  )
    .bind(id, await sha256Hex(key), email, now, now)
    .first<{ plan: string }>();
  if (!row) return jsonUtf8(c, { error: "a key already exists for this email" }, 409, NO_STORE);

  return jsonUtf8(c, { key, key_id: id, plan: row.plan, email }, 201, NO_STORE);
  },
);

export default keys;
