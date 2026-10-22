// Candidate advisories for a check: the rows whose (ecosystem, component)
// matches a dependency. The keys go in as one JSON parameter per chunk, because
// D1 allows at most 100 bound parameters per statement.
import { normalizePypiName } from "./match/pep440";
import type { Dependency } from "./parsers";

export const CHUNK_SIZE = 200;

// Served by idx_advisories_component_ecosystem (tests/routes/check-plan.tcs-9.test.ts).
export const CANDIDATE_SQL =
  "SELECT doc_json FROM advisories WHERE (component, ecosystem) IN " +
  "(SELECT json_extract(value, '$[1]'), json_extract(value, '$[0]') FROM json_each(?))";

// Served by idx_advisories_cursor.
export const FEED_CURSOR_SQL = "SELECT COALESCE(MAX(cursor), 0) AS c FROM advisories";

export type CandidateKey = [ecosystem: string, component: string];

/** Distinct [ecosystem, name] pairs. PyPI and python also add the PEP 503 name, which the matcher compares. */
export function candidateKeys(deps: Dependency[]): CandidateKey[] {
  const seen = new Set<string>();
  const keys: CandidateKey[] = [];
  const add = (ecosystem: string, name: string) => {
    const k = `${ecosystem}\u0000${name}`;
    if (seen.has(k)) return;
    seen.add(k);
    keys.push([ecosystem, name]);
  };
  for (const d of deps) {
    add(d.ecosystem, d.name);
    if (d.ecosystem === "PyPI" || d.ecosystem === "python") add(d.ecosystem, normalizePypiName(d.name));
  }
  return keys;
}
