// Pub: Dart's pub_semver. SemVer 2 precedence; then build metadata breaks a
// tie: no build < a build, and two builds compare like pre-release lists
// (1.2.3 < 1.2.3+1 < 1.2.3+2 < 1.2.3+10 < 1.2.3+a). No `v` prefix.
import { compareBuild, parse } from "semver";
import type { Comparator } from "./types";

export function validPub(v: string): boolean {
  const s = v.trim();
  return /^\d/.test(s) && parse(s, { loose: false }) !== null;
}

export function comparePub(a: string, b: string): number {
  if (!validPub(a) || !validPub(b)) throw new Error(`invalid Pub version: ${validPub(a) ? b : a}`);
  return compareBuild(a.trim(), b.trim());
}

export const pubComparator: Comparator = { valid: validPub, compare: comparePub };
