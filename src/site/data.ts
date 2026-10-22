import type { LatestRow } from "../../site/landing";
import type { StatusData, StatusSource } from "../../site/status";
import type { Env } from "../env";
import { buildEventsQuery, MAX_LIMIT } from "../feed/query";
import { getSettingInt } from "../lib/settings";
import type { Advisory } from "../schema/advisory";

export const LATEST_KEY = "site:latest:v1";
// Documented fallbacks. The live values are the settings rows
// site.latest_rows and site.latest_cache_seconds (migrations/0006).
const DEFAULT_ROWS = 10;
const DEFAULT_TTL = 60;
// KV refuses an expirationTtl below 60 seconds.
const MIN_TTL = 60;

export const STATUS_SOURCES_SQL =
  "SELECT id, kind, last_run_at, last_ok_at, last_error FROM sources WHERE enabled = 1 ORDER BY id";
export const STATUS_CURSOR_SQL = "SELECT MAX(cursor) AS cursor FROM advisories";

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// The newest advisories for the landing page. KV first; on a miss, one D1
// read, then a KV put. A D1 failure returns null and caches nothing.
export async function loadLatest(env: Env): Promise<LatestRow[] | null> {
  try {
    const hit = await env.CURSORS.get<LatestRow[]>(LATEST_KEY, "json");
    if (hit) return hit;
  } catch (err) {
    console.error(JSON.stringify({ lane: "site", step: "kv-get", err: errText(err) }));
  }

  let [rows, ttl] = await Promise.all([
    getSettingInt(env.DB, "site.latest_rows", DEFAULT_ROWS),
    getSettingInt(env.DB, "site.latest_cache_seconds", DEFAULT_TTL),
  ]);
  if (rows < 1 || rows > MAX_LIMIT) {
    console.error(JSON.stringify({ lane: "site", setting: "site.latest_rows", value: rows, used: DEFAULT_ROWS }));
    rows = DEFAULT_ROWS;
  }
  if (ttl < MIN_TTL) {
    console.error(JSON.stringify({ lane: "site", setting: "site.latest_cache_seconds", value: ttl, used: MIN_TTL }));
    ttl = MIN_TTL;
  }

  let latest: LatestRow[];
  try {
    const { sql, params } = buildEventsQuery({
      since: 0,
      limit: rows,
      ecosystem: [],
      component: [],
      min_severity: null,
      exploited: false,
      order: "desc",
    });
    const { results } = await env.DB.prepare(sql)
      .bind(...params)
      .all<{ cursor: number; doc_json: string }>();
    latest = results.slice(0, rows).map((r) => {
      const d = JSON.parse(r.doc_json) as Advisory;
      return {
        id: d.id,
        when: d.published_at,
        ecosystem: d.ecosystem,
        component: d.component,
        cve: d.cve_ids[0] ?? null,
        severity: d.severity.label,
        action: d.action,
      };
    });
  } catch (err) {
    console.error(JSON.stringify({ lane: "site", step: "latest-read", err: errText(err) }));
    return null;
  }

  try {
    await env.CURSORS.put(LATEST_KEY, JSON.stringify(latest), { expirationTtl: ttl });
  } catch (err) {
    console.error(JSON.stringify({ lane: "site", step: "kv-put", err: errText(err) }));
  }
  return latest;
}

// One round trip: the enabled sources and the newest feed cursor. The cursor
// is 0 only when no advisory exists (0 is the feed's start value for since=).
export async function loadStatus(db: D1Database): Promise<StatusData> {
  const [sources, cursor] = await db.batch([db.prepare(STATUS_SOURCES_SQL), db.prepare(STATUS_CURSOR_SQL)]);
  const max = (cursor.results[0] as { cursor: number | null } | undefined)?.cursor ?? null;
  return { sources: sources.results as unknown as StatusSource[], cursor: max === null ? 0 : max };
}
