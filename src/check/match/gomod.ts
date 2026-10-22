// Go modules: `v`-prefixed semver; `+incompatible` and build metadata do not affect order.
// Two pseudo-versions on the same base compare by their 14-digit commit timestamp.
// The `go` runtime (go1.22.3, 1.21rc2) is normalized to the same form first.
import { compare, parse } from "semver";
import type { Comparator } from "./types";

// vX.0.0-TS-HASH, vX.Y.Z-pre.0.TS-HASH, vX.Y.Z-0.TS-HASH. Group 1 is the base, group 2 the timestamp.
const PSEUDO = /^(.*?)(?:^|\.)(\d{14})-[0-9a-f]{12}$/;

function core(v: string): string | null {
  const s = v.trim();
  if (!s.startsWith("v")) return null;
  const body = s.slice(1);
  return /^\d+\.\d+\.\d+/.test(body) && parse(body) !== null ? body : null;
}

export function parseGo(v: string): boolean {
  return core(v) !== null;
}

export function compareGo(a: string, b: string): number {
  const ca = core(a);
  const cb = core(b);
  if (ca === null || cb === null) throw new Error(`invalid Go version: ${ca === null ? a : b}`);
  const sa = parse(ca)!;
  const sb = parse(cb)!;
  const pa = PSEUDO.exec(sa.prerelease.join("."));
  const pb = PSEUDO.exec(sb.prerelease.join("."));
  if (pa && pb && sa.compareMain(sb) === 0 && pa[1] === pb[1]) {
    return pa[2] < pb[2] ? -1 : pa[2] > pb[2] ? 1 : 0;
  }
  return compare(sa, sb);
}

// Go toolchain versions: go1.22.3 -> v1.22.3, 1.21 -> v1.21.0, 1.21rc2 -> v1.21.0-rc.2.
export function normalizeGoRuntime(v: string): string {
  const s = v.trim().replace(/^go/, "").replace(/^v/, "");
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:(alpha|beta|rc)(\d+))?$/.exec(s);
  if (!m) return `v${s}`;
  const [, major, minor, patch, pre, preN] = m;
  return `v${major}.${minor}.${patch ?? "0"}${pre ? `-${pre}.${preN}` : ""}`;
}

export const goComparator: Comparator = { valid: parseGo, compare: compareGo };

export const goRuntimeComparator: Comparator = {
  valid: (v) => parseGo(normalizeGoRuntime(v)),
  compare: (a, b) => compareGo(normalizeGoRuntime(a), normalizeGoRuntime(b)),
};
