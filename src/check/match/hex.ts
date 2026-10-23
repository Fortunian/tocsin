// Hex: Elixir's Version. Strict SemVer 2 with three parts; pre-release order
// as SemVer; build metadata does not count. No `v` prefix.
import { compare, parse } from "semver";
import type { Comparator } from "./types";

export function validHex(v: string): boolean {
  const s = v.trim();
  return /^\d/.test(s) && parse(s, { loose: false }) !== null;
}

export function compareHex(a: string, b: string): number {
  if (!validHex(a) || !validHex(b)) throw new Error(`invalid Hex version: ${validHex(a) ? b : a}`);
  return compare(a.trim(), b.trim());
}

export const hexComparator: Comparator = { valid: validHex, compare: compareHex };
