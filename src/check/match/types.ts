// Types for the version range matcher. Pure data, no I/O.

// One dependency as a lockfile parser produces it.
export type Dependency = { ecosystem: string; name: string; version: string };

// Why a dependency could not be checked. A skipped result is not a clean "not affected".
export type SkipReason = "unsupported_ecosystem" | "invalid_version" | "invalid_range";

export type MatchResult = { affected: boolean; fixed_in?: string; skipped?: SkipReason };

// Version rules for one ecosystem. `compare` is only called on versions `valid` accepted.
export interface Comparator {
  valid(v: string): boolean;
  compare(a: string, b: string): number;
}
