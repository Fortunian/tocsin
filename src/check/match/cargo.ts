// crates.io: strict semver. Cargo versions have no `v` prefix and always three parts.
import { compare, parse } from "semver";
import type { Comparator } from "./types";

export function parseCargo(v: string): boolean {
  const s = v.trim();
  return /^\d/.test(s) && parse(s) !== null;
}

export function compareCargo(a: string, b: string): number {
  return compare(a.trim(), b.trim());
}

export const cargoComparator: Comparator = { valid: parseCargo, compare: compareCargo };
