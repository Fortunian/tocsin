// Packagist and php: Composer version rules. Optional `v` prefix, 1 to 4 numeric parts
// padded to 4, then a stability: dev < alpha < beta < RC < stable < patch.
// Branch versions (`dev-main`) have no order and are invalid.
import type { Comparator } from "./types";

const COMPOSER = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[._-]?(stable|beta|b|rc|alpha|a|patch|pl|p)((?:[.-]?\d+)*))?(?:[.-]?(dev))?$/i;

const RANK: Record<string, number> = { alpha: 1, a: 1, beta: 2, b: 2, rc: 3, stable: 4, patch: 5, pl: 5, p: 5 };
const DEV = 0;
const STABLE = 4;

interface Composer {
  parts: number[];
  stability: number;
  stabilityNums: number[];
  dev: boolean;
}

export function parseComposer(v: string): Composer | null {
  const m = COMPOSER.exec(v.trim());
  if (!m) return null;
  const [, p1, p2, p3, p4, label, nums, dev] = m;
  const parts = [p1, p2, p3, p4].map((p) => (p ? Number(p) : 0));
  const stabilityNums = nums ? (nums.match(/\d+/g) ?? []).map(Number) : [];
  // A bare `-dev` (1.0.0-dev) is the dev stability; `-beta2-dev` is a dev build of beta2.
  if (!label) return { parts, stability: dev ? DEV : STABLE, stabilityNums, dev: false };
  return { parts, stability: RANK[label.toLowerCase()], stabilityNums, dev: Boolean(dev) };
}

function cmpNums(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareComposer(a: string, b: string): number {
  const pa = parseComposer(a);
  const pb = parseComposer(b);
  if (!pa || !pb) throw new Error(`invalid Composer version: ${pa ? b : a}`);
  return (
    cmpNums(pa.parts, pb.parts) ||
    cmpNums([pa.stability], [pb.stability]) ||
    cmpNums(pa.stabilityNums, pb.stabilityNums) ||
    cmpNums([pa.dev ? 0 : 1], [pb.dev ? 0 : 1])
  );
}

export const composerComparator: Comparator = { valid: (v) => parseComposer(v) !== null, compare: compareComposer };
