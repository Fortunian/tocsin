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
  lookupName,
} from "./candidates";
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
}

const SEVERITY_RANK: Record<SeverityLabel, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

const groupKey = (ecosystem: string, component: string) => `${ecosystem}\u0000${component}`;

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
  const [cursorRes, ...chunkRes] = await db.batch<{ c?: number; doc_json?: string }>(stmts);
  const feed_cursor = Number(cursorRes.results[0]?.c ?? 0);

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
    const candidates = byKey.get(groupKey(dep.ecosystem, lookupName(dep.ecosystem, dep.name))) ?? [];
    const skippedIds = new Map<string, string[]>();
    for (const a of candidates) {
      const r = matchAdvisory(dep, a);
      if (r.affected) {
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
  }

  affected.sort(
    (x, y) =>
      SEVERITY_RANK[y.severity.label] - SEVERITY_RANK[x.severity.label] ||
      Number(y.exploited) - Number(x.exploited) ||
      cmp(x.advisory_id, y.advisory_id) ||
      cmp(x.dependency.name, y.dependency.name) ||
      cmp(x.dependency.version, y.dependency.version),
  );

  return { checked: checkedDeps.length, affected, skipped, feed_cursor };
}

function addCandidate(byKey: Map<string, Advisory[]>, a: Advisory): void {
  const k = groupKey(a.ecosystem, lookupName(a.ecosystem, a.component));
  const list = byKey.get(k);
  if (list) list.push(a);
  else byKey.set(k, [a]);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
