import type { SeverityLabel } from "../schema/advisory";

// The social lane's knobs (CLAUDE.md rule 5). The live values are the
// settings rows social.x.* (migrations/0033_social_posts.sql); the constants
// below are the documented code fallbacks only, each named by its row.
export const SOCIAL_FALLBACKS = {
  enabled: false, // social.x.enabled
  minSeverity: "critical" as SeverityLabel, // social.x.min_severity
  sources: ["node-runtime", "php-runtime", "python-runtime", "deno-runtime", "bun-runtime", "osv-go-toolchain"], // social.x.sources
  dailyCap: 10, // social.x.daily_cap
  maxAgeHours: 72, // social.x.max_age_hours
  scanRows: 200, // social.x.scan_rows
  maxAttempts: 3, // social.x.max_attempts
  retrySeconds: 600, // social.x.retry_seconds
  leaseSeconds: 300, // social.x.lease_seconds
  timeoutMs: 10_000, // social.x.timeout_ms
  maxChars: 280, // social.x.max_chars
  urlChars: 23, // social.x.url_chars
  minSummaryChars: 60, // social.x.min_summary_chars
};

export type SocialConfig = typeof SOCIAL_FALLBACKS;

const INT_KEYS = {
  "social.x.daily_cap": "dailyCap",
  "social.x.max_age_hours": "maxAgeHours",
  "social.x.scan_rows": "scanRows",
  "social.x.max_attempts": "maxAttempts",
  "social.x.retry_seconds": "retrySeconds",
  "social.x.lease_seconds": "leaseSeconds",
  "social.x.timeout_ms": "timeoutMs",
  "social.x.max_chars": "maxChars",
  "social.x.url_chars": "urlChars",
  "social.x.min_summary_chars": "minSummaryChars",
} as const;

export const SOCIAL_SETTING_KEYS = ["social.x.enabled", "social.x.min_severity", "social.x.sources", ...Object.keys(INT_KEYS)];

// One statement: PK seeks on settings for every social.x.* key.
export const SOCIAL_CONFIG_SQL = `SELECT key, value FROM settings WHERE key IN (${SOCIAL_SETTING_KEYS.map((k) => `'${k}'`).join(", ")})`;

export const SEVERITY_RANK: Record<SeverityLabel, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

function malformed(key: string, value: string): void {
  console.error(JSON.stringify({ lane: "social", key, value, err: "malformed setting, using the code fallback" }));
}

// Parses the rows of SOCIAL_CONFIG_SQL. A missing row takes the fallback; a
// malformed row takes the fallback and logs. enabled is true only for "1".
export function parseSocialConfig(rows: { key: string; value: string }[]): SocialConfig {
  const cfg: SocialConfig = { ...SOCIAL_FALLBACKS, sources: [...SOCIAL_FALLBACKS.sources] };
  for (const { key, value } of rows) {
    const v = value.trim();
    if (key === "social.x.enabled") {
      cfg.enabled = v === "1";
    } else if (key === "social.x.min_severity") {
      if (v in SEVERITY_RANK && v !== "unknown") cfg.minSeverity = v as SeverityLabel;
      else malformed(key, v);
    } else if (key === "social.x.sources") {
      const list = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
      if (list.length > 0) cfg.sources = list;
      else malformed(key, v);
    } else if (key in INT_KEYS) {
      if (/^\d+$/.test(v)) cfg[INT_KEYS[key as keyof typeof INT_KEYS]] = Number(v);
      else malformed(key, v);
    }
  }
  return cfg;
}

export async function readSocialConfig(db: D1Database): Promise<SocialConfig> {
  const { results } = await db.prepare(SOCIAL_CONFIG_SQL).all<{ key: string; value: string }>();
  return parseSocialConfig(results);
}
