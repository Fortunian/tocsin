// Version range matcher: is this dependency inside an advisory's affected ranges?
// Pure functions, no I/O. Consumers read `skipped` to report what could not be checked.
import type { Advisory } from "../../schema/advisory";
import { cargoComparator } from "./cargo";
import { composerComparator } from "./composer";
import { gemComparator } from "./gem";
import { goComparator, goRuntimeComparator } from "./gomod";
import { normalizePypiName, pep440Comparator } from "./pep440";
import { inRange, lowestFixedAbove } from "./range";
import { semverComparator } from "./semver";
import type { Comparator, Dependency, MatchResult } from "./types";

export type { Dependency, MatchResult } from "./types";

// Ecosystem names are exact OSV / runtime names. This maps a name to code, not to a business value.
const COMPARATORS: Record<string, Comparator> = {
  npm: semverComparator,
  node: semverComparator,
  deno: semverComparator,
  bun: semverComparator,
  PyPI: pep440Comparator,
  python: pep440Comparator,
  Packagist: composerComparator,
  php: composerComparator,
  Go: goComparator,
  go: goRuntimeComparator,
  "crates.io": cargoComparator,
  RubyGems: gemComparator,
};

/** True when the matcher has version rules for this ecosystem name. */
export function supportsEcosystem(ecosystem: string): boolean {
  return Object.hasOwn(COMPARATORS, ecosystem);
}

function sameName(ecosystem: string, a: string, b: string): boolean {
  if (ecosystem === "PyPI" || ecosystem === "python") return normalizePypiName(a) === normalizePypiName(b);
  return a === b;
}

export function matchAdvisory(dep: Dependency, advisory: Advisory): MatchResult {
  if (dep.ecosystem !== advisory.ecosystem || !sameName(dep.ecosystem, dep.name, advisory.component)) {
    return { affected: false };
  }
  const cmp = Object.hasOwn(COMPARATORS, dep.ecosystem) ? COMPARATORS[dep.ecosystem] : undefined;
  if (!cmp) return { affected: false, skipped: "unsupported_ecosystem" };
  if (!cmp.valid(dep.version)) return { affected: false, skipped: "invalid_version" };

  let invalidRange = false;
  let affected = false;
  for (const r of advisory.affected) {
    const hit = inRange(dep.version, r, cmp);
    if (hit === undefined) invalidRange = true;
    else if (hit) {
      affected = true;
      break;
    }
  }
  if (!affected) return invalidRange ? { affected: false, skipped: "invalid_range" } : { affected: false };

  const candidates = [
    ...advisory.affected.flatMap((r) => (r.fixed === undefined ? [] : [r.fixed])),
    ...advisory.fixed_versions,
  ];
  const fixed_in = lowestFixedAbove(dep.version, candidates, cmp);
  return fixed_in === undefined ? { affected: true } : { affected: true, fixed_in };
}

export function isAffected(dep: Dependency, advisory: Advisory): boolean {
  return matchAdvisory(dep, advisory).affected;
}
