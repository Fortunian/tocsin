// Candidate advisories for a check: the rows whose (ecosystem, component)
// matches a dependency. The keys go in as one JSON parameter per chunk, because
// D1 allows at most 100 bound parameters per statement.
import { baseEcosystem } from "../ingest/osv";
import { normalizePypiName } from "./match/pep440";
import type { Dependency } from "./parsers";

export const CHUNK_SIZE = 200;

// Served by idx_advisories_component_ecosystem (tests/routes/check-plan.tcs-9.test.ts).
export const CANDIDATE_SQL =
  "SELECT doc_json FROM advisories WHERE (component, ecosystem) IN " +
  "(SELECT json_extract(value, '$[1]'), json_extract(value, '$[0]') FROM json_each(?))";

// Served by idx_advisories_cursor.
export const FEED_CURSOR_SQL = "SELECT COALESCE(MAX(cursor), 0) AS c FROM advisories";

// PEP 503 name in SQL: lowercase, `_` and `.` become `-`, then runs of `-`
// collapse (4 passes collapse a run of up to 16). Served by the partial
// expression index idx_advisories_pypi_name (migrations/0005); the text must
// stay identical to the index expression.
export const PYPI_NAME_EXPR =
  "replace(replace(replace(replace(replace(replace(lower(trim(component)), '_', '-'), '.', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-')";

// PyPI and python rows: OSV keeps the PyPI case (Django), so the match is on the normalized name.
// The name-only IN is the index seek (SQLite does not seek an expression index
// on a row-value IN); the pair IN then keeps only the asked ecosystem.
export const PYPI_CANDIDATE_SQL =
  "SELECT doc_json FROM advisories WHERE ecosystem IN ('PyPI', 'python') AND " +
  `${PYPI_NAME_EXPR} IN (SELECT json_extract(value, '$[1]') FROM json_each(?1)) AND ` +
  `(${PYPI_NAME_EXPR}, ecosystem) IN ` +
  "(SELECT json_extract(value, '$[1]'), json_extract(value, '$[0]') FROM json_each(?1))";

// OSV `Go` rows on the toolchain (stdlib, toolchain, cmd/*), read for a `go`
// runtime dependency. The unary `+` makes the ecosystem term non-indexable, so
// the planner never picks idx_advisories_ecosystem_cursor (ecosystem=?) and
// reads every Go row. The plan is a MULTI-INDEX OR on
// idx_advisories_component_ecosystem: one seek per IN value (component=?) and
// one range seek (component>? AND component<?, where '0' is the character after
// '/'). The ecosystem filter runs on those few rows only. It holds with and
// without ANALYZE: tests/check/go-runtime.tcs-40.test.ts.
export const GO_RUNTIME_CANDIDATE_SQL =
  "SELECT doc_json FROM advisories WHERE +ecosystem = 'Go' AND " +
  "(component IN ('stdlib', 'toolchain') OR (component >= 'cmd/' AND component < 'cmd0'))";

export type CandidateKey = [ecosystem: string, component: string];

export function isPypi(ecosystem: string): boolean {
  return ecosystem === "PyPI" || ecosystem === "python";
}

/**
 * The ecosystem a dependency or advisory is grouped and queried by: the base
 * name (a Debian:12 dependency reads the Debian rows; the release is checked
 * by the matcher). Stored advisories already hold the base name.
 */
export function lookupEcosystem(ecosystem: string): string {
  return baseEcosystem(ecosystem);
}

/** The name a dependency or advisory is grouped and queried by: the PEP 503 name for PyPI and python. */
export function lookupName(ecosystem: string, name: string): string {
  return isPypi(ecosystem) ? normalizePypiName(name) : name;
}

/** Distinct [ecosystem, lookup name] pairs, split by the query that serves them. */
export function candidateKeys(deps: Dependency[]): { exact: CandidateKey[]; pypi: CandidateKey[] } {
  const seen = new Set<string>();
  const exact: CandidateKey[] = [];
  const pypi: CandidateKey[] = [];
  for (const d of deps) {
    const ecosystem = lookupEcosystem(d.ecosystem);
    const name = lookupName(ecosystem, d.name);
    const k = `${ecosystem}\u0000${name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    (isPypi(ecosystem) ? pypi : exact).push([ecosystem, name]);
  }
  return { exact, pypi };
}
