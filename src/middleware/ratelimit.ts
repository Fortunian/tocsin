import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";

// Code fallbacks only. The live limits are settings.feed.anon_rate_per_minute
// and settings.check.anon_rate_per_minute.
export const FALLBACK_RATE_PER_MINUTE = 60;
export const FALLBACK_CHECK_RATE_PER_MINUTE = 20;
const WINDOW_MS = 60_000;

interface RateLimitConfig {
  settingKey: string;
  fallback: number;
  // Empty for the feed (its key family predates scopes). Any other value gets
  // its own counter, so one route's traffic never uses another route's budget.
  scope: string;
}

// Fixed one-minute window per client IP, counted in the CURSORS KV under the
// rl: prefix. KV is eventually consistent, so the count is approximate under
// bursts across locations. A KV write fault lets the request through: a
// counter fault must not take the public feed down.
export function makeRateLimit({ settingKey, fallback, scope }: RateLimitConfig): MiddlewareHandler<{ Bindings: Env }> {
  const prefix = scope === "" ? "rl:v1:" : `rl:v1:${scope}:`;
  return async (c, next) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const now = Date.now();
    const window = Math.floor(now / WINDOW_MS);
    const key = `${prefix}${ip}:${window}`;

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
  };
}

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
