// Alpine: apk-tools version order. Dotted numbers (a shorter list sorts
// lower: 1.2 < 1.2.0), an optional letter (none < a < b), suffixes
// _alpha < _beta < _pre < _rc < (none) < _cvs < _svn < _git < _hg < _p, each
// with an optional number (none < 0), then -r<N> (none < -r0). Number parts
// compare as numbers, except that a part after the first with leading zeros
// reads as a fraction, as apk-tools does: 4.09 < 4.5, 1.009 < 1.09.
import type { Comparator } from "./types";

const SUFFIXES = ["alpha", "beta", "pre", "rc", "", "cvs", "svn", "git", "hg", "p"];
const NONE = SUFFIXES.indexOf("");
const APK = /^(\d+(?:\.\d+)*)([a-z])?((?:_(?:alpha|beta|pre|rc|cvs|svn|git|hg|p)\d*)*)(?:-r(\d+))?$/;

interface Apk {
  nums: number[];
  letter: string;
  suffixes: [number, number][];
  rev: number;
}

export function parseApk(v: string): Apk | null {
  const m = APK.exec(v.trim());
  if (!m) return null;
  const suffixes = [...m[3].matchAll(/_([a-z]+)(\d*)/g)].map(
    ([, name, n]) => [SUFFIXES.indexOf(name), n === "" ? -1 : Number(n)] as [number, number],
  );
  return { nums: numberTokens(m[1]), letter: m[2] ?? "", suffixes, rev: m[4] === undefined ? -1 : Number(m[4]) };
}

// apk-tools tokens of the dotted part: a later part that starts with zeros is
// the negative count of its zeros, then the number after them (0 when none).
function numberTokens(dotted: string): number[] {
  return dotted.split(".").flatMap((part, i) => {
    const zeros = /^0*/.exec(part)![0].length;
    return i === 0 || zeros === 0 ? [Number(part)] : [-zeros, Number(part.slice(zeros) || "0")];
  });
}

const cmp = <T>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

export function compareApk(a: string, b: string): number {
  const pa = parseApk(a);
  const pb = parseApk(b);
  if (!pa || !pb) throw new Error(`invalid apk version: ${pa ? b : a}`);
  const n = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < n; i++) {
    if (pa.nums[i] === undefined) return -1;
    if (pb.nums[i] === undefined) return 1;
    if (pa.nums[i] !== pb.nums[i]) return cmp(pa.nums[i], pb.nums[i]);
  }
  if (pa.letter !== pb.letter) return cmp(pa.letter, pb.letter);
  const s = Math.max(pa.suffixes.length, pb.suffixes.length);
  for (let i = 0; i < s; i++) {
    const [ra, na] = pa.suffixes[i] ?? [NONE, -1];
    const [rb, nb] = pb.suffixes[i] ?? [NONE, -1];
    if (ra !== rb) return cmp(ra, rb);
    if (na !== nb) return cmp(na, nb);
  }
  return cmp(pa.rev, pb.rev);
}

export const apkComparator: Comparator = { valid: (v) => parseApk(v) !== null, compare: compareApk };
