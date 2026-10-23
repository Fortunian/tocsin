// The stored dependency set of a watch list (TCS-37, migrations/0028): the SQL
// of the upload route and of the dependency match pass, and the JS form of the
// list filter that the pass applies to each match.
import { lookupEcosystem, lookupName } from "../check/candidates";
import type { Dependency } from "../check/parsers";
import { severitiesAtLeast } from "../feed/query";
import type { WatchlistFilter } from "./filter";

// Code fallbacks only. The live values are the settings rows
// webhooks.dependency_scan_rows and webhooks.dependency_insert_chunk
// (migrations/0028_watchlist_dependencies.sql).
export const FALLBACK_DEPENDENCY_SCAN_ROWS = 2000;
export const FALLBACK_DEPENDENCY_INSERT_CHUNK = 500;

// The match lane row in match_cursors.
export const DEPENDENCY_LANE = "dependencies";

// Upload, step 1: the old set of the list, guarded by the key.
// idx_watchlist_dependencies_watchlist.
export const DEPENDENCY_DELETE_SQL =
  "DELETE FROM watchlist_dependencies WHERE watchlist_id IN (SELECT id FROM watchlists WHERE id = ?1 AND key_id = ?2)";

// Upload, step 2: one chunk of the new set as one JSON parameter (?3), each
// item [ecosystem, name, dep_ecosystem, dep_name, version]. D1 allows 100
// bound parameters per statement; this uses 3.
export const DEPENDENCY_INSERT_SQL = `INSERT OR IGNORE INTO watchlist_dependencies (watchlist_id, ecosystem, name, dep_ecosystem, dep_name, version)
  SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]')
  FROM json_each(?3) WHERE EXISTS (SELECT 1 FROM watchlists WHERE id = ?1 AND key_id = ?2)`;

// The stored count of one list. idx_watchlist_dependencies_watchlist.
export const DEPENDENCY_COUNT_SQL = "SELECT COUNT(*) FROM watchlist_dependencies WHERE watchlist_id = ?1";

// Upload, step 3: the list's count, its check cursor and the upload time.
export const DEPENDENCY_LIST_UPDATE_SQL = `UPDATE watchlists SET dependency_count = (${DEPENDENCY_COUNT_SQL}),
  dependencies_cursor = ?3, dependencies_at = ?4 WHERE id = ?1 AND key_id = ?2`;

// Upload, step 4: the match lane never stays above the upload's check cursor.
// A pass that read the old set and moves the lane after this commit fails its
// compare-and-set, so the next pass reads those advisories again.
export const MATCH_REWIND_SQL = `UPDATE match_cursors SET cursor = MIN(cursor, ?1), updated_at = ?2 WHERE lane = '${DEPENDENCY_LANE}'`;

export const MATCH_CURSOR_SQL = `SELECT cursor FROM match_cursors WHERE lane = '${DEPENDENCY_LANE}'`;

// Pass, step 1: the advisories above the lane cursor, oldest first, without
// doc_json. idx_advisories_cursor.
export const DEPENDENCY_WINDOW_SQL = `SELECT id, cursor, ecosystem, component, severity_label, exploited, published_at, exploited_at
  FROM advisories WHERE cursor > ? ORDER BY cursor LIMIT ?`;

// Pass, step 2: the stored dependencies of webhook lists under a chunk of
// [ecosystem, name] keys (one JSON parameter). idx_watchlist_dependencies_ecosystem_name,
// then the watchlists primary key.
export const DEPENDENCY_MATCH_SQL = `SELECT d.watchlist_id, d.ecosystem, d.name, d.dep_ecosystem, d.dep_name, d.version,
  w.filter_json, w.dependencies_cursor, w.dependencies_at
  FROM watchlist_dependencies d JOIN watchlists w ON w.id = d.watchlist_id
  WHERE (d.ecosystem, d.name) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
    AND w.delivery = 'webhook'`;

// Pass, step 3: doc_json of the advisories with a candidate pair. Primary key.
export const DEPENDENCY_DOCS_SQL = "SELECT id, doc_json FROM advisories WHERE id IN (SELECT value FROM json_each(?))";

// Pass, step 4: one chunk of new deliveries rows (?1, items [watchlist_id,
// advisory_id, cursor, status, affected_json]). The primary key
// (watchlist_id, advisory_id) is the exactly-once gate; RETURNING gives only
// the new rows. A row is written only while the advisory is still above the
// list's dependencies_cursor, so a pass that read a set replaced by a later
// upload writes nothing for that list.
export const DEPENDENCY_DELIVERY_INSERT_SQL = `INSERT OR IGNORE INTO deliveries (watchlist_id, advisory_id, cursor, attempt, status, next_at, affected_json)
  SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), 0, json_extract(j.value, '$[3]'), ?2, json_extract(j.value, '$[4]')
  FROM json_each(?1) j
  WHERE EXISTS (SELECT 1 FROM watchlists w WHERE w.id = json_extract(j.value, '$[0]') AND w.dependencies_cursor < json_extract(j.value, '$[2]'))
  RETURNING watchlist_id, advisory_id, status`;

// Pass, step 5: compare-and-set of the lane cursor (?3 = the cursor the pass
// started from).
export const MATCH_ADVANCE_SQL = `UPDATE match_cursors SET cursor = ?1, updated_at = ?2 WHERE lane = '${DEPENDENCY_LANE}' AND cursor = ?3`;

/** One stored row as the upload writes it: [ecosystem, name, dep_ecosystem, dep_name, version]. */
export function dependencyRow(d: Dependency): [string, string, string, string, string] {
  const ecosystem = lookupEcosystem(d.ecosystem);
  return [ecosystem, lookupName(ecosystem, d.name), d.ecosystem, d.name, d.version];
}

/** The advisory columns the filter reads. */
export interface FilterRow {
  ecosystem: string;
  component: string;
  severity_label: string;
  exploited: number;
}

/**
 * The JS form of watchlistWhere (src/watchlists/query.ts) without the cursor
 * term: ecosystems (plus runtime names), components, min_severity and
 * exploited_only, all AND. tests/watch/dependency-match.tcs-37.test.ts pins
 * the parity with the SQL.
 */
export function filterAccepts(f: WatchlistFilter, a: FilterRow): boolean {
  const ecosystems = [...f.ecosystems, ...Object.keys(f.runtimes)];
  if (ecosystems.length && !ecosystems.includes(a.ecosystem)) return false;
  if (f.components.length && !f.components.includes(a.component)) return false;
  if (f.min_severity && !(severitiesAtLeast(f.min_severity) as string[]).includes(a.severity_label)) return false;
  if (f.exploited_only && a.exploited !== 1) return false;
  return true;
}
