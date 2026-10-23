import type { Context, MiddlewareHandler, Next } from "hono";
import type { Env } from "../env";
import type { AuthEnv } from "./auth";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";

// Code fallbacks only. The live limits are settings.feed.anon_rate_per_minute,
// settings.check.anon_rate_per_minute, settings.keys.anon_rate_per_minute and
// settings.watchlists.key_rate_per_minute.
export const FALLBACK_RATE_PER_MINUTE = 60;
export const FALLBACK_CHECK_RATE_PER_MINUTE = 20;
export const FALLBACK_KEYS_RATE_PER_MINUTE = 5;
export const FALLBACK_KEY_RATE_PER_MINUTE = 120;
const WINDOW_MS = 60_000;

interface RateLimitConfig {
  settingKey: string;
  fallback: number;
  // Empty for the feed (its key family predates scopes). Any other value gets
  // its own counter, so one route's traffic never uses another route's budget.
  scope: string;
}

// Fixed one-minute window per caller id (a client IP or an API key id),
// counted in the CURSORS KV under the rl: prefix. KV is eventually
// consistent, so the count is approximate under bursts across locations. A KV
// write fault lets the request through: a counter fault must not take the
// API down.
async function countAndGate<E extends { Bindings: Env }>(c: Context<E>, next: Next, counterPrefix: string, settingKey: string, fallback: number) {
  const now = Date.now();
  const window = Math.floor(now / WINDOW_MS);
  const key = `${counterPrefix}${window}`;

  const [limit, raw] = await Promise.all([getSettingInt(c.env.DB, settingKey, fallback), c.env.CURSORS.get(key)]);
  const count = raw === null ? 0 : Number(raw) || 0;

  if (count >= limit) {
    const retryAfter = Math.max(1, Math.ceil(((window + 1) * WINDOW_MS - now) / 1000));
    return jsonUtf8(c, { error: "rate limited" }, 429, {
      "Retry-After": String(retryAfter),
      "Cache-Control": "no-store",
    });
  }

  try {
    await c.env.CURSORS.put(key, String(count + 1), { expirationTtl: 120 });
  } catch (err) {
    console.error(JSON.stringify({ lane: "ratelimit", err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
  }
  await next();
}

// Per client IP: rl:v1:[<scope>:]<ip>:<minute>.
export function makeRateLimit({ settingKey, fallback, scope }: RateLimitConfig): MiddlewareHandler<{ Bindings: Env }> {
  const prefix = scope === "" ? "rl:v1:" : `rl:v1:${scope}:`;
  return (c, next) => countAndGate(c, next, `${prefix}${c.req.header("CF-Connecting-IP") ?? "unknown"}:`, settingKey, fallback);
}

// Per API key, after requireApiKey: rl:v1:key:<key_id>:<minute>. Every
// authenticated route shares one budget per key, from any IP.
export const keyRateLimit: MiddlewareHandler<AuthEnv> = (c, next) =>
  countAndGate(c, next, `rl:v1:key:${c.var.apiKey.id}:`, "watchlists.key_rate_per_minute", FALLBACK_KEY_RATE_PER_MINUTE);

export const rateLimit = makeRateLimit({
  settingKey: "feed.anon_rate_per_minute",
  fallback: FALLBACK_RATE_PER_MINUTE,
  scope: "",
});

export const checkRateLimit = makeRateLimit({
  settingKey: "check.anon_rate_per_minute",
  fallback: FALLBACK_CHECK_RATE_PER_MINUTE,
  scope: "check",
});

export const keysRateLimit = makeRateLimit({
  settingKey: "keys.anon_rate_per_minute",
  fallback: FALLBACK_KEYS_RATE_PER_MINUTE,
  scope: "keys",
});
