import type { Context, MiddlewareHandler, Next } from "hono";
import type { Env } from "../env";
import type { AuthEnv } from "./auth";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";

// Code fallbacks only. The live limits are settings.feed.anon_rate_per_minute,
// settings.check.anon_rate_per_minute, settings.keys.anon_rate_per_minute,
// settings.watchlists.key_rate_per_minute and settings.watchlists.ip_rate_per_minute.
// The memo window of the last one is settings.watchlists.ip_rate_cache_seconds.
export const FALLBACK_RATE_PER_MINUTE = 60;
export const FALLBACK_CHECK_RATE_PER_MINUTE = 20;
export const FALLBACK_KEYS_RATE_PER_MINUTE = 5;
export const FALLBACK_KEY_RATE_PER_MINUTE = 120;
export const FALLBACK_IP_AUTH_RATE_PER_MINUTE = 300;
export const FALLBACK_IP_AUTH_RATE_CACHE_SECONDS = 60;
const WINDOW_MS = 60_000;

interface RateLimitConfig {
  settingKey: string;
  fallback: number;
  // Empty for the feed (its key family predates scopes). Any other value gets
  // its own counter, so one route's traffic never uses another route's budget.
  scope: string;
  // Optional: the settings row that holds how many seconds this isolate keeps
  // the limit in memory. While the memo is warm, a request makes no D1 read.
  // 0 turns the memo off.
  memo?: { settingKey: string; fallback: number };
}

type LimitReader = (db: D1Database) => Promise<number>;

const limitMemo = new Map<string, { value: number; until: number }>();

// Tests change settings rows between requests; this drops every memoized limit.
export function clearLimitMemo(): void {
  limitMemo.clear();
}

function limitReader({ settingKey, fallback, memo }: RateLimitConfig): LimitReader {
  if (!memo) return (db) => getSettingInt(db, settingKey, fallback);
  return async (db) => {
    const now = Date.now();
    const hit = limitMemo.get(settingKey);
    if (hit && hit.until > now) return hit.value;
    const [value, seconds] = await Promise.all([getSettingInt(db, settingKey, fallback), getSettingInt(db, memo.settingKey, memo.fallback)]);
    if (seconds > 0) limitMemo.set(settingKey, { value, until: now + seconds * 1000 });
    else limitMemo.delete(settingKey);
    return value;
  };
}

// Fixed one-minute window per caller id (a client IP or an API key id),
// counted in the CURSORS KV under the rl: prefix. KV is eventually
// consistent, so the count is approximate under bursts across locations. A KV
// write fault lets the request through: a counter fault must not take the
// API down.
async function countAndGate<E extends { Bindings: Env }>(c: Context<E>, next: Next, counterPrefix: string, readLimit: LimitReader) {
  const now = Date.now();
  const window = Math.floor(now / WINDOW_MS);
  const key = `${counterPrefix}${window}`;

  const [limit, raw] = await Promise.all([readLimit(c.env.DB), c.env.CURSORS.get(key)]);
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
export function makeRateLimit(config: RateLimitConfig): MiddlewareHandler<{ Bindings: Env }> {
  const prefix = config.scope === "" ? "rl:v1:" : `rl:v1:${config.scope}:`;
  const readLimit = limitReader(config);
  return (c, next) => countAndGate(c, next, `${prefix}${c.req.header("CF-Connecting-IP") ?? "unknown"}:`, readLimit);
}

// Per API key, after requireApiKey: rl:v1:key:<key_id>:<minute>. Every
// authenticated route shares one budget per key, from any IP.
const readKeyLimit = limitReader({ settingKey: "watchlists.key_rate_per_minute", fallback: FALLBACK_KEY_RATE_PER_MINUTE, scope: "key" });
export const keyRateLimit: MiddlewareHandler<AuthEnv> = (c, next) => countAndGate(c, next, `rl:v1:key:${c.var.apiKey.id}:`, readKeyLimit);

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

// Per client IP, before requireApiKey on /v1/watchlists/* and before
// keysRateLimit on /v1/keys: an unknown-key flood stops here, with no SHA-256
// and no read of api_keys. One budget per IP for both routes. The limit is
// memoized per isolate, so a refused request makes no D1 read at all.
export const authIpRateLimit = makeRateLimit({
  settingKey: "watchlists.ip_rate_per_minute",
  fallback: FALLBACK_IP_AUTH_RATE_PER_MINUTE,
  scope: "auth",
  memo: { settingKey: "watchlists.ip_rate_cache_seconds", fallback: FALLBACK_IP_AUTH_RATE_CACHE_SECONDS },
});
