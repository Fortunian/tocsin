// npm, node, deno, bun: semver 2.0 precedence via the `semver` package.
// Loose parse so `v24.22.0` and `=1.0.0` are accepted.
import { compare, parse } from "semver";
import type { Comparator } from "./types";

export function parseSemver(v: string): boolean {
  return parse(v.trim(), { loose: true }) !== null;
}

export function compareSemver(a: string, b: string): number {
  return compare(a.trim(), b.trim(), { loose: true });
}

export const semverComparator: Comparator = { valid: parseSemver, compare: compareSemver };
