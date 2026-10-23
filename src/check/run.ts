// One check: load the candidate advisories for a set of dependencies, match
// each dependency against them, and answer the affected ones in a fixed order.
// Read-only over D1: one batch per check.
import type { Advisory, SeverityLabel } from "../schema/advisory";
import {
  CANDIDATE_SQL,
  CHUNK_SIZE,
  FEED_CURSOR_SQL,
  GO_RUNTIME_CANDIDATE_SQL,
  PYPI_CANDIDATE_SQL,
  candidateKeys,
  lookupEcosystem,
  lookupName,
} from "./candidates";
import { COVERAGE_SQL, SOURCE_COVERAGE_SQL, coverageFor, type Coverage, type CoverageRows } from "./coverage";
import { goRuntimeView, isGoToolchainAdvisory, needsGoToolchainRows } from "./go-runtime";
import { matchAdvisory, supportsEcosystem } from "./match";
import type { Dependency } from "./parsers";

export interface AffectedItem {
  dependency: Dependency;
  advisory_id: string;
  cve_ids: string[];
  severity: Advisory["severity"];
  exploited: boolean;
  fixed_in: string | null;
  action: string;
  url: string;
}

export interface CheckResult {
  checked: number;
  affected: AffectedItem[];
  skipped: object[];
  feed_cursor: number;
  // One entry per ecosystem of the checked dependencies (TCS-32).
  coverage: Coverage[];
}

const SEVERITY_RANK: Record<SeverityLabel, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

// Advisories and dependencies meet on the base ecosystem (a Debian:12
// dependency reads the Debian group); the matcher checks the release.
const groupKey = (ecosystem: string, component: string) => {
  const e = lookupEcosystem(ecosystem);
  return `${e}\u0000${lookupName(e, component)}`;
};

export async function runCheck(db: D1Database, deps: Dependency[], parseSkipped: object[]): Promise<CheckResult> {
  const skipped: object[] = [...parseSkipped];
  const checkedDeps: Dependency[] = [];
  for (const dep of deps) {
    if (supportsEcosystem(dep.ecosystem)) checkedDeps.push(dep);
    else skipped.push({ dependency: dep, reason: "unsupported_ecosystem" });
  }

  // The cursor read goes first in the batch, so feed_cursor is never past an
  // advisory this check did not see.
  const { exact, pypi } = candidateKeys(checkedDeps);
  const stmts = [db.prepare(FEED_CURSOR_SQL)];
  for (const [sql, keys] of [[CANDIDATE_SQL, exact], [PYPI_CANDIDATE_SQL, pypi]] as const) {
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
      stmts.push(db.prepare(sql).bind(JSON.stringify(keys.slice(i, i + CHUNK_SIZE))));
    }
  }
  if (needsGoToolchainRows(checkedDeps)) stmts.push(db.prepare(GO_RUNTIME_CANDIDATE_SQL));
  // The two coverage reads ride the same batch: still one round trip.
  stmts.push(db.prepare(COVERAGE_SQL), db.prepare(SOURCE_COVERAGE_SQL));
  const results = await db.batch<{ c?: number; doc_json?: string }>(stmts);
  const [cursorRes, ...chunkRes] = results.slice(0, -2);
  const [backfillRes, sourcesRes] = results.slice(-2);
  const feed_cursor = Number(cursorRes.results[0]?.c ?? 0);
  const coverage = coverageFor(
    checkedDeps.map((d) => d.ecosystem),
    { backfill: backfillRes.results, sources: sourcesRes.results } as unknown as CoverageRows,
  );
  const partial = new Map(coverage.filter((c) => !c.complete).map((c) => [c.ecosystem, c]));

  const byKey = new Map<string, Advisory[]>();
  const seenIds = new Set<string>();
  for (const res of chunkRes) {
    for (const row of res.results) {
      const a = JSON.parse(row.doc_json as string) as Advisory;
      if (seenIds.has(a.id)) continue;
      seenIds.add(a.id);
      addCandidate(byKey, a);
      // The same row, read as the `go` runtime (TCS-40). Not a second advisory.
      if (isGoToolchainAdvisory(a)) addCandidate(byKey, goRuntimeView(a));
    }
  }

  const affected: AffectedItem[] = [];
  for (const dep of checkedDeps) {
    const candidates = byKey.get(groupKey(dep.ecosystem, dep.name)) ?? [];
    const skippedIds = new Map<string, string[]>();
    let hit = false;
    for (const a of candidates) {
      const r = matchAdvisory(dep, a);
      if (r.affected) {
        hit = true;
        affected.push({
          dependency: dep,
          advisory_id: a.id,
          cve_ids: a.cve_ids,
          severity: a.severity,
          exploited: a.exploited,
          fixed_in: r.fixed_in ?? null,
          action: a.action,
          url: a.sources[0].url,
        });
      } else if (r.skipped) {
        const ids = skippedIds.get(r.skipped) ?? [];
        ids.push(a.id);
        skippedIds.set(r.skipped, ids);
      }
    }
    for (const [reason, advisory_ids] of skippedIds) {
      skipped.push({ dependency: dep, reason, advisory_ids: advisory_ids.sort() });
    }
    // No finding and no other skip reason, in an ecosystem whose history is
    // not complete: not checked, so never reported as clean.
    const gap = partial.get(dep.ecosystem);
    if (gap && !hit && skippedIds.size === 0) skipped.push({ dependency: dep, reason: "partial_coverage", since: gap.since });
  }

  affected.sort(
    (x, y) =>
      SEVERITY_RANK[y.severity.label] - SEVERITY_RANK[x.severity.label] ||
      Number(y.exploited) - Number(x.exploited) ||
      cmp(x.advisory_id, y.advisory_id) ||
      cmp(x.dependency.name, y.dependency.name) ||
      cmp(x.dependency.version, y.dependency.version),
  );

  return { checked: checkedDeps.length, affected, skipped, feed_cursor, coverage };
}

function addCandidate(byKey: Map<string, Advisory[]>, a: Advisory): void {
  const k = groupKey(a.ecosystem, a.component);
  const list = byKey.get(k);
  if (list) list.push(a);
  else byKey.set(k, [a]);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
