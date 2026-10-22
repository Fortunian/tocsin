// RubyGems: Gem::Version rules. `-` becomes `.pre.`, segments are runs of digits or
// letters, trailing zeros are dropped, a letter segment marks a pre-release and sorts
// below any number, letters compare lexically.
import type { Comparator } from "./types";

const GEM = /^[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type Segment = number | string;

export function parseGem(v: string): boolean {
  return GEM.test(v.trim());
}

function trimZeros(segs: Segment[]): Segment[] {
  let end = segs.length;
  while (end > 0 && segs[end - 1] === 0) end--;
  return segs.slice(0, end);
}

// Gem::Version#canonical_segments: release and pre-release parts each lose trailing zeros.
function canonical(v: string): Segment[] {
  const segs: Segment[] = (v.trim().replace(/-/g, ".pre.").match(/[0-9]+|[a-z]+/gi) ?? []).map((s) =>
    /^\d/.test(s) ? Number(s) : s,
  );
  const firstString = segs.findIndex((s) => typeof s === "string");
  if (firstString === -1) return trimZeros(segs);
  return [...trimZeros(segs.slice(0, firstString)), ...trimZeros(segs.slice(firstString))];
}

export function compareGem(a: string, b: string): number {
  if (!parseGem(a) || !parseGem(b)) throw new Error(`invalid gem version: ${parseGem(a) ? b : a}`);
  const x = canonical(a);
  const y = canonical(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const l = x[i] ?? 0;
    const r = y[i] ?? 0;
    if (l === r) continue;
    if (typeof l === "string" && typeof r === "number") return -1;
    if (typeof l === "number" && typeof r === "string") return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export const gemComparator: Comparator = { valid: parseGem, compare: compareGem };
