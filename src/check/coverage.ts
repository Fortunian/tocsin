import { baseEcosystem } from "../ingest/osv";

// Honest coverage (TCS-32): for each ecosystem of a check, since when Tocsin
// holds its advisories and whether that history is complete. A dependency
// with no finding in an incomplete ecosystem is reported as partial_coverage,
// never as clean.

// backfill has one row per OSV ecosystem and sources one row per source
// (docs/RETENTION.md): both reads are small, bounded full reads
// (tests/routes/backfill-plan.tcs-32.test.ts).
export const COVERAGE_SQL = "SELECT ecosystem, coverage_since, done_at FROM backfill";
export const SOURCE_COVERAGE_SQL = "SELECT id, coverage_since FROM sources WHERE enabled = 1";

export interface Coverage {
  ecosystem: string;
  since: string | null;
  complete: boolean;
}

export interface CoverageRows {
  backfill: { ecosystem: string; coverage_since: string | null; done_at: string | null }[];
  sources: { id: string; coverage_since: string | null }[];
}

export type CoverageOwner = { table: "backfill"; key: string } | { table: "sources"; key: string };

// The row that holds the coverage of a check ecosystem. This maps names to
// code (which table and key), not a business value. OSV package ecosystems
// own their backfill row; the `go` runtime reads OSV `Go` toolchain rows
// (src/check/go-runtime.ts), so it follows the `Go` row; the other runtimes
// own their runtime source row. A release-scoped OS ecosystem (Debian:12)
// follows the backfill row of its base name (Debian).
const RUNTIME_SOURCES: Record<string, string> = {
  node: "node-runtime",
  php: "php-runtime",
  python: "python-runtime",
  deno: "deno-runtime",
  bun: "bun-runtime",
};

export function coverageOwner(ecosystem: string): CoverageOwner {
  if (ecosystem === "go") return { table: "backfill", key: "Go" };
  if (Object.hasOwn(RUNTIME_SOURCES, ecosystem)) return { table: "sources", key: RUNTIME_SOURCES[ecosystem] };
  return { table: "backfill", key: baseEcosystem(ecosystem) };
}

export const byEcosystem = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

// One entry per distinct ecosystem, sorted. A backfill row is complete when
// it has done_at; a source row when it has coverage_since. No row: partial.
export function coverageFor(ecosystems: string[], rows: CoverageRows): Coverage[] {
  const backfill = new Map(rows.backfill.map((r) => [r.ecosystem, r]));
  const sources = new Map(rows.sources.map((r) => [r.id, r]));
  return [...new Set(ecosystems)].sort(byEcosystem).map((ecosystem) => {
    const owner = coverageOwner(ecosystem);
    if (owner.table === "backfill") {
      const r = backfill.get(owner.key);
      return { ecosystem, since: r?.coverage_since ?? null, complete: r !== undefined && r.done_at !== null };
    }
    const r = sources.get(owner.key);
    return { ecosystem, since: r?.coverage_since ?? null, complete: r !== undefined && r.coverage_since !== null };
  });
}
