// The CISA KEV ingester: downloads the Known Exploited Vulnerabilities JSON
// feed once per run and sets exploited=true on every advisory whose primary
// CVE is listed. A newly exploited advisory gets a new cursor, so feed
// subscribers see it again. exploited is never set back to false.
// This file is the KEV seam: the only code that reads the KEV feed.
import { appendSource, canonicalJson, checked, UPSERT_SQL } from "./upsert";
import { posIntConfig, urlConfig } from "./config";
import type { IngestContext, Ingester, RunResult } from "./types";
import type { Advisory } from "../schema/advisory";

// Code fallbacks for sources.config_json of row "kev" (repo iron rule 5).
const DEFAULTS = {
  feed_url: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
  max_updates_per_run: 500,
};

const CVE = /^CVE-\d{4}-\d{4,}$/;
// D1 allows 100 bound parameters per statement.
const CHUNK = 90;

export const KEV_SQL = {
  // idx_advisories_cve_primary. `exploited = 0` is the watermark: a flagged row is never read again.
  match: (n: number) => `SELECT id, cve_primary, doc_json FROM advisories WHERE cve_primary IN (${Array(n).fill("?").join(", ")}) AND exploited = 0 ORDER BY cve_primary, id`,
  update: `UPDATE advisories SET exploited = 1, doc_json = ?, cursor = ${UPSERT_SQL.nextCursor} WHERE id = ? AND exploited = 0`,
} as const;

export class KevHttpError extends Error {
  constructor(readonly status: number) {
    super(`KEV feed HTTP ${status}`);
    this.name = "KevHttpError";
  }
}

export class KevFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KevFormatError";
  }
}

// The CVE ids the feed lists. A body that is not the KEV feed shape throws:
// a broken download must never read as "nothing is exploited".
export function kevCves(body: unknown): string[] {
  const list = (body as { vulnerabilities?: unknown } | null)?.vulnerabilities;
  if (!Array.isArray(list)) throw new KevFormatError("KEV feed has no vulnerabilities list");
  const ids = new Set<string>();
  for (const v of list) {
    const id = (v as { cveID?: unknown } | null)?.cveID;
    if (typeof id === "string" && CVE.test(id)) ids.add(id);
  }
  return [...ids].sort();
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const raw = ctx.source.config;
  const feedUrl = urlConfig(raw, "kev", "feed_url", DEFAULTS.feed_url);
  const maxUpdates = posIntConfig(raw, "kev", "max_updates_per_run", DEFAULTS.max_updates_per_run);
  const db = ctx.env.DB;

  const res = await ctx.fetch(feedUrl);
  if (!res.ok) throw new KevHttpError(res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new KevFormatError("KEV feed is not JSON");
  }
  const cves = kevCves(body);

  const result: RunResult = { fetched: 1, upserted: 0, unchanged: 0, errors: [], deferred: 0 };
  for (let i = 0; i < cves.length; i += CHUNK) {
    const chunk = cves.slice(i, i + CHUNK);
    const { results } = await db.prepare(KEV_SQL.match(chunk.length)).bind(...chunk).all<{ id: string; cve_primary: string; doc_json: string }>();
    const writes: D1PreparedStatement[] = [];
    for (const row of results) {
      if (result.upserted + writes.length >= maxUpdates) {
        // Still exploited = 0, so the next run picks it up.
        result.deferred! += 1;
        continue;
      }
      const doc = JSON.parse(row.doc_json) as Advisory;
      let next: Advisory;
      try {
        next = checked({
          ...doc,
          exploited: true,
          sources: appendSource(doc.sources, { source: "kev", source_id: row.cve_primary, url: feedUrl }),
        });
      } catch (err) {
        result.errors.push(`${row.cve_primary}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      writes.push(db.prepare(KEV_SQL.update).bind(canonicalJson(next), row.id));
    }
    if (writes.length > 0) {
      for (const w of await db.batch(writes)) result.upserted += w.meta.changes ?? 0;
    }
  }
  // The registry's run log line carries deferred and incomplete.
  result.incomplete = result.deferred! > 0;
  return result;
}

export const kev: Ingester = { id: "kev", run };
