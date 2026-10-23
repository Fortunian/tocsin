import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";
import { getSettingInt } from "../lib/settings";

// Code fallback only. The live value is settings.auth.last_used_resolution_seconds.
export const FALLBACK_LAST_USED_RESOLUTION_SECONDS = 86_400;

export interface PlanLimits {
  max_watchlists: number;
  webhooks: number;
  max_components: number;
}

export interface ApiKey {
  id: string;
  plan: string;
  limits: PlanLimits;
}

export type AuthEnv = { Bindings: Env; Variables: { apiKey: ApiKey } };

// Key and plan in one statement (idx_api_keys_key_hash). LEFT JOIN so a key
// whose plan row is missing is told apart from an unknown key.
export const AUTH_SQL = `SELECT k.id, k.plan, k.last_used_at, p.id AS plan_id, p.max_watchlists, p.webhooks, p.max_components
  FROM api_keys k LEFT JOIN plans p ON p.id = k.plan WHERE k.key_hash = ?`;

const BEARER_RE = /^\s*bearer\s+(tcs_\S+)\s*$/i;

interface AuthRow {
  id: string;
  plan: string;
  last_used_at: string;
  plan_id: string | null;
  max_watchlists: number | null;
  webhooks: number | null;
  max_components: number | null;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

function unauthorized(c: Parameters<MiddlewareHandler>[0]): Response {
  return jsonUtf8(c, { error: "missing or invalid API key" }, 401, { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" });
}

// Authorization: Bearer tcs_<hex>. Sets c.var.apiKey with the plan limits, so
// a route reads the plan once per request.
export const requireApiKey: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const m = BEARER_RE.exec(c.req.header("Authorization") ?? "");
  if (!m) return unauthorized(c);
  const hash = await sha256Hex(m[1]);

  const [row, resolution] = await Promise.all([
    c.env.DB.prepare(AUTH_SQL).bind(hash).first<AuthRow>(),
    getSettingInt(c.env.DB, "auth.last_used_resolution_seconds", FALLBACK_LAST_USED_RESOLUTION_SECONDS),
  ]);
  if (!row) return unauthorized(c);
  if (row.plan_id === null || row.max_watchlists === null || row.webhooks === null || row.max_components === null) {
    // Fail closed: a key with no plan row gets no limits from a code constant.
    console.error(JSON.stringify({ lane: "auth", err: "plan row missing", key_id: row.id, plan: row.plan }));
    return jsonUtf8(c, { error: "internal error" }, 500);
  }

  // last_used_at feeds the retention cron. It moves at most once per
  // resolution window, so most requests write nothing.
  const now = Date.now();
  const stale = new Date(now - resolution * 1000).toISOString();
  if (row.last_used_at < stale) {
    await c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND last_used_at < ?")
      .bind(new Date(now).toISOString(), row.id, stale)
      .run();
  }

  c.set("apiKey", {
    id: row.id,
    plan: row.plan,
    limits: { max_watchlists: row.max_watchlists, webhooks: row.webhooks, max_components: row.max_components },
  });
  await next();
};
