// PyPI and python: PEP 440 version ordering. Hand-written, no external package.
// The regex and the sort key follow the reference implementation in `packaging.version`.
import type { Comparator } from "./types";

const PEP440 = new RegExp(
  "^v?" +
    "(?:(\\d+)!)?" + // epoch
    "(\\d+(?:\\.\\d+)*)" + // release
    "(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\\d+)?)?" + // pre
    "(?:-(\\d+)|[-_.]?(post|rev|r)[-_.]?(\\d+)?)?" + // post
    "(?:[-_.]?(dev)[-_.]?(\\d+)?)?" + // dev
    "(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$", // local
  "i",
);

interface Pep440 {
  epoch: number;
  release: number[];
  pre?: [number, number];
  post?: number;
  dev?: number;
  local?: (number | string)[];
}

const PRE_RANK: Record<string, number> = { alpha: 0, a: 0, beta: 1, b: 1, c: 2, rc: 2, pre: 2, preview: 2 };

export function parsePep440(v: string): Pep440 | null {
  const m = PEP440.exec(v.trim());
  if (!m) return null;
  const [, epoch, release, preL, preN, postN1, postL, postN2, devL, devN, local] = m;
  const out: Pep440 = { epoch: epoch ? Number(epoch) : 0, release: release.split(".").map(Number) };
  if (preL) out.pre = [PRE_RANK[preL.toLowerCase()], preN ? Number(preN) : 0];
  if (postN1 !== undefined) out.post = Number(postN1);
  else if (postL) out.post = postN2 ? Number(postN2) : 0;
  if (devL) out.dev = devN ? Number(devN) : 0;
  if (local) out.local = local.toLowerCase().split(/[-_.]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  return out;
}

function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// A release with trailing zeros removed: 1.0 == 1.0.0.
function cmpRelease(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpNum(a[i] ?? 0, b[i] ?? 0);
    if (c) return c;
  }
  return 0;
}

// Pre-release key. A dev-only release (1.0.dev1) sorts before any pre-release of it;
// a final release sorts after its pre-releases.
function preKey(v: Pep440): [number, number] {
  if (v.pre) return v.pre;
  if (v.post === undefined && v.dev !== undefined) return [-Infinity, 0];
  return [Infinity, 0];
}

// Local segments: numbers sort above strings, strings compare lexically, shorter loses.
function cmpLocal(a: (number | string)[] | undefined, b: (number | string)[] | undefined): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x !== typeof y) return typeof x === "number" ? 1 : -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function cmpParsed(a: Pep440, b: Pep440): number {
  const [pa, pb] = [preKey(a), preKey(b)];
  return (
    cmpNum(a.epoch, b.epoch) ||
    cmpRelease(a.release, b.release) ||
    cmpNum(pa[0], pb[0]) ||
    cmpNum(pa[1], pb[1]) ||
    cmpNum(a.post ?? -Infinity, b.post ?? -Infinity) ||
    cmpNum(a.dev ?? Infinity, b.dev ?? Infinity) ||
    cmpLocal(a.local, b.local)
  );
}

export function comparePep440(a: string, b: string): number {
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (!pa || !pb) throw new Error(`invalid PEP 440 version: ${pa ? b : a}`);
  return cmpParsed(pa, pb);
}

// PEP 503 name normalization: lowercase, runs of `-`, `_`, `.` become one `-`.
export function normalizePypiName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

export const pep440Comparator: Comparator = { valid: (v) => parsePep440(v) !== null, compare: comparePep440 };
