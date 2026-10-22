// OSV range logic shared by every ecosystem.
import type { AffectedRange } from "../../schema/advisory";
import type { Comparator } from "./types";

// `introduced` absent or "0" = from the beginning (inclusive). `fixed` is exclusive,
// `last_affected` is inclusive, no upper bound = open-ended.
// Returns undefined when a bound does not parse, so the caller can report it.
export function inRange(v: string, r: AffectedRange, cmp: Comparator): boolean | undefined {
  const lower = r.introduced === undefined || r.introduced.trim() === "0" ? undefined : r.introduced;
  for (const bound of [lower, r.fixed, r.last_affected]) {
    if (bound !== undefined && !cmp.valid(bound)) return undefined;
  }
  if (lower !== undefined && cmp.compare(v, lower) < 0) return false;
  if (r.fixed !== undefined && cmp.compare(v, r.fixed) >= 0) return false;
  if (r.last_affected !== undefined && cmp.compare(v, r.last_affected) > 0) return false;
  return true;
}

// The lowest candidate strictly greater than `v`. Candidates that do not parse are ignored.
export function lowestFixedAbove(v: string, candidates: string[], cmp: Comparator): string | undefined {
  let best: string | undefined;
  for (const c of candidates) {
    if (!cmp.valid(c) || cmp.compare(c, v) <= 0) continue;
    if (best === undefined || cmp.compare(c, best) < 0) best = c;
  }
  return best;
}
