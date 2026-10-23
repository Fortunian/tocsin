// NuGet: SemVer 2 with 1 to 4 numeric parts (missing parts are 0, so 1.0 =
// 1.0.0.0). Pre-release labels compare case-insensitive; a numeric label
// compares as a number and sorts below a text label. Build metadata (+...) does not count.
import type { Comparator } from "./types";

const LABEL = "[0-9A-Za-z-]+";
const NUGET = new RegExp(`^(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-(${LABEL}(?:\\.${LABEL})*))?(?:\\+(${LABEL}(?:\\.${LABEL})*))?$`);

interface NuGet {
  parts: number[];
  pre: string[];
}

export function parseNuget(v: string): NuGet | null {
  const m = NUGET.exec(v.trim());
  if (!m) return null;
  return { parts: [m[1], m[2], m[3], m[4]].map((p) => (p ? Number(p) : 0)), pre: m[5] ? m[5].toLowerCase().split(".") : [] };
}

const cmp = <T>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

function cmpLabel(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return cmp(Number(a), Number(b));
  if (na !== nb) return na ? -1 : 1;
  return cmp(a, b);
}

export function compareNuget(a: string, b: string): number {
  const pa = parseNuget(a);
  const pb = parseNuget(b);
  if (!pa || !pb) throw new Error(`invalid NuGet version: ${pa ? b : a}`);
  for (let i = 0; i < 4; i++) if (pa.parts[i] !== pb.parts[i]) return cmp(pa.parts[i], pb.parts[i]);
  // A release sorts above its pre-releases.
  if (pa.pre.length === 0 || pb.pre.length === 0) return cmp(pb.pre.length === 0 ? 0 : 1, pa.pre.length === 0 ? 0 : 1);
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    if (pa.pre[i] === undefined) return -1;
    if (pb.pre[i] === undefined) return 1;
    const c = cmpLabel(pa.pre[i], pb.pre[i]);
    if (c !== 0) return c;
  }
  return 0;
}

export const nugetComparator: Comparator = { valid: (v) => parseNuget(v) !== null, compare: compareNuget };
