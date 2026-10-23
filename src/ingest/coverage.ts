// sources.coverage_since (TCS-32): the oldest published_at a source holds,
// written once, after a run that read the source's whole history. NULL
// until then; /v1/check reports a dependency with no finding in that
// ecosystem as partial_coverage.

// The oldest advisory of one source: the PK range of advisory_sources
// (source = ?), then the PK of advisories. A runtime source holds hundreds of
// rows, not the OSV 280k (OSV coverage comes from the backfill table).
export const OLDEST_PUBLISHED_SQL =
  "SELECT MIN(a.published_at) AS m FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = ?";
// Only a NULL value is written: coverage_since never moves once set.
export const SET_COVERAGE_SQL = "UPDATE sources SET coverage_since = ? WHERE id = ? AND coverage_since IS NULL";

// Sets coverage_since to the oldest advisory the source holds, or to `fallback`
// (the run time) when it holds none. Returns the value written, or null when
// the row already had one.
export async function markCoverage(db: D1Database, source: string, fallback: string): Promise<string | null> {
  const oldest = await db.prepare(OLDEST_PUBLISHED_SQL).bind(source).first<{ m: string | null }>();
  const since = oldest?.m ?? fallback;
  const res = await db.prepare(SET_COVERAGE_SQL).bind(since, source).run();
  return res.meta.changes > 0 ? since : null;
}
