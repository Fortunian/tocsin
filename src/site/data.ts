import type { Freshness } from "../../site/freshness";
import type { LatestRow } from "../../site/landing";
import type { StatusData, StatusSource } from "../../site/status";
import type { Env } from "../env";
import { byEcosystem, coverageFor } from "../check/coverage";
import { RUNTIMES } from "../check/parsers/runtimes";
import { LEDGER_TABLES, ledgerSql, toLedgerCounts, type LedgerRow } from "../ingest/ledgers";
import { OSV_CONFIG_SQL, readConfig } from "../ingest/osv";
import { MAX_LIMIT } from "../feed/query";
import { getSettingInt } from "../lib/settings";
import type { Advisory } from "../schema/advisory";

export const LATEST_KEY = "site:latest:v2";
// Newest by publish date, not by feed cursor: cursor order is ingest order, so a
// re-touched old advisory would push a fresh one out. idx_advisories_published_at (0008).
export const LATEST_SQL = "SELECT cursor, doc_json FROM advisories ORDER BY published_at DESC, cursor DESC LIMIT ?";
// Documented fallbacks. The live values are the settings rows
// site.latest_rows and site.latest_cache_seconds (migrations/0006).
const DEFAULT_ROWS = 10;
const DEFAULT_TTL = 60;
// KV refuses an expirationTtl below 60 seconds.
const MIN_TTL = 60;

export const STATUS_SOURCES_SQL =
  "SELECT id, kind, last_run_at, last_ok_at, last_error, last_warning, coverage_since FROM sources WHERE enabled = 1 ORDER BY id";
// Coverage (TCS-32): backfill has one row per OSV ecosystem and sources one row
// per source, so both are small bounded reads.
export const STATUS_BACKFILL_SQL = "SELECT ecosystem, coverage_since, done_at, imported, unchanged FROM backfill";
export const STATUS_CURSOR_SQL = "SELECT MAX(cursor) AS cursor FROM advisories";

// The landing page data, cached as one KV value under LATEST_KEY (TCS-35).
export interface Home {
  rows: LatestRow[] | null;
  freshness: Freshness | null;
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// A value cached before TCS-35 is a bare array of rows; it reads as a miss.
function isHome(v: unknown): v is Home {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const h = v as Partial<Home>;
  return Array.isArray(h.rows) && typeof h.freshness === "object" && h.freshness !== null;
}

async function cachedHome(env: Env): Promise<Home | null> {
  try {
    const hit = await env.CURSORS.get<unknown>(LATEST_KEY, "json");
    return isHome(hit) ? hit : null;
  } catch (err) {
    console.error(JSON.stringify({ lane: "site", step: "kv-get", err: errText(err) }));
    return null;
  }
}

async function latestSettings(env: Env): Promise<{ rows: number; ttl: number }> {
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
  return { rows, ttl };
}

function toRow(docJson: string): LatestRow {
  const d = JSON.parse(docJson) as Advisory;
  return {
    id: d.id,
    when: d.published_at,
    ecosystem: d.ecosystem,
    component: d.component,
    cve: d.cve_ids[0] ?? null,
    severity: d.severity.label,
    action: d.action,
  };
}

async function readLatest(db: D1Database, rows: number): Promise<LatestRow[] | null> {
  try {
    const { results } = await db.prepare(LATEST_SQL).bind(rows).all<{ cursor: number; doc_json: string }>();
    return results.slice(0, rows).map((r) => toRow(r.doc_json));
  } catch (err) {
    console.error(JSON.stringify({ lane: "site", step: "latest-read", err: errText(err) }));
    return null;
  }
}

async function readFreshness(db: D1Database): Promise<Freshness | null> {
  try {
    return freshnessOf(await loadStatus(db));
  } catch (err) {
    console.error(JSON.stringify({ lane: "site", step: "status-read", err: errText(err) }));
    return null;
  }
}

// The freshness numbers from one loadStatus read. A source is ok when it has
// had a good run and its last run left no error. `updated` is the newest good run.
export function freshnessOf(status: StatusData): Freshness {
  const ok = status.sources.filter((s) => s.last_error === null && s.last_ok_at !== null).length;
  const times = status.sources.map((s) => s.last_ok_at).filter((t): t is string => t !== null);
  const updated = times.length ? times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
  return { updated, ok, total: status.sources.length };
}

// KV first; on a miss, the Latest read and one loadStatus read in parallel,
// then ONE KV put that holds both. A failed read returns null for its part
// and caches nothing, so the next request reads D1 again.
export async function loadHome(env: Env): Promise<Home> {
  const hit = await cachedHome(env);
  if (hit) return hit;
  const { rows, ttl } = await latestSettings(env);
  const [latest, freshness] = await Promise.all([readLatest(env.DB, rows), readFreshness(env.DB)]);
  const home: Home = { rows: latest, freshness };
  if (latest === null || freshness === null) return home;
  try {
    await env.CURSORS.put(LATEST_KEY, JSON.stringify(home), { expirationTtl: ttl });
  } catch (err) {
    console.error(JSON.stringify({ lane: "site", step: "kv-put", err: errText(err) }));
  }
  return home;
}

// One round trip: the enabled sources and the newest feed cursor. The cursor
// is 0 only when no advisory exists (0 is the feed's start value for since=).
// With `ledger: true` the same batch also reads one grouped count per ledger
// table (LEDGER_TABLES), attached to its source when that source is enabled.
// With `coverage: true` the batch also reads the backfill rows and the osv
// config, for one coverage row per enabled OSV ecosystem and per runtime.
// Home and the badge call it without the options and make neither read.
export async function loadStatus(db: D1Database, opts: { ledger?: boolean; coverage?: boolean } = {}): Promise<StatusData> {
  const ledgers = opts.ledger ? Object.entries(LEDGER_TABLES) : [];
  const coverageStmts = opts.coverage ? [db.prepare(STATUS_BACKFILL_SQL), db.prepare(OSV_CONFIG_SQL)] : [];
  const [sources, cursor, ...rest] = await db.batch([
    db.prepare(STATUS_SOURCES_SQL),
    db.prepare(STATUS_CURSOR_SQL),
    ...ledgers.map(([, table]) => db.prepare(ledgerSql(table))),
    ...coverageStmts,
  ]);
  const counts = rest.slice(0, ledgers.length);
  const max = (cursor.results[0] as { cursor: number | null } | undefined)?.cursor ?? null;
  const list = sources.results as unknown as StatusSource[];
  ledgers.forEach(([id], i) => {
    const s = list.find((x) => x.id === id);
    if (s) s.ledger = toLedgerCounts(counts[i].results as unknown as LedgerRow[]);
  });
  const data: StatusData = { sources: list, cursor: max === null ? 0 : max };
  if (opts.coverage) {
    const [backfillRes, cfgRes] = rest.slice(ledgers.length);
    const backfill = backfillRes.results as unknown as { ecosystem: string; coverage_since: string | null; done_at: string | null; imported: number; unchanged: number }[];
    const cfgRow = cfgRes.results[0] as { config_json: string } | undefined;
    let osvEcosystems: string[];
    try {
      osvEcosystems = readConfig(cfgRow ? (JSON.parse(cfgRow.config_json) as Record<string, unknown>) : {}).ecosystems;
    } catch (err) {
      // A bad osv config fails the osv cron run; the status page still shows the rows it has.
      console.error(JSON.stringify({ lane: "site", step: "osv-config", err: errText(err) }));
      osvEcosystems = backfill.map((b) => b.ecosystem);
    }
    const rows = { backfill, sources: list.map((s) => ({ id: s.id, coverage_since: s.coverage_since })) };
    const seen = new Map(backfill.map((b) => [b.ecosystem, b.imported + b.unchanged]));
    data.coverage = [
      // `imported`: the records the latest backfill run of the ecosystem has written or found unchanged.
      ...coverageFor([...osvEcosystems].sort(byEcosystem), rows).map((c) => ({ ...c, imported: seen.get(c.ecosystem) ?? 0 })),
      ...coverageFor([...RUNTIMES], rows).map((c) => ({ ...c, imported: null })),
    ];
  }
  return data;
}
