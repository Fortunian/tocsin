// Version range matcher: is this dependency inside an advisory's affected ranges?
// Pure functions, no I/O. Consumers read `skipped` to report what could not be checked.
import { baseEcosystem, RELEASE_SCOPED } from "../../ingest/osv";
import type { Advisory } from "../../schema/advisory";
import { apkComparator } from "./apk";
import { cargoComparator } from "./cargo";
import { composerComparator } from "./composer";
import { dpkgComparator } from "./dpkg";
import { gemComparator } from "./gem";
import { goComparator, goRuntimeComparator } from "./gomod";
import { hexComparator } from "./hex";
import { mavenComparator } from "./maven";
import { nugetComparator } from "./nuget";
import { normalizePypiName, pep440Comparator } from "./pep440";
import { pubComparator } from "./pub";
import { inRange, lowestFixedAbove } from "./range";
import { semverComparator } from "./semver";
import type { Comparator, Dependency, MatchResult } from "./types";

export type { Dependency, MatchResult } from "./types";

// Ecosystem names are exact OSV / runtime names. This maps a name to code, not to a business value.
// Alpine and Debian (RELEASE_SCOPED) are reached only with a release: Alpine:v3.18, Debian:12.
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
  Maven: mavenComparator,
  NuGet: nugetComparator,
  Hex: hexComparator,
  Pub: pubComparator,
  Alpine: apkComparator,
  Debian: dpkgComparator,
};

// A release-scoped base takes its comparator only with a non-empty release
// (Debian:12); every other name must match exactly (no suffix).
function comparatorFor(ecosystem: string): Comparator | undefined {
  const base = baseEcosystem(ecosystem);
  const key = RELEASE_SCOPED.has(base) ? (ecosystem.length > base.length + 1 ? base : undefined) : ecosystem;
  return key !== undefined && Object.hasOwn(COMPARATORS, key) ? COMPARATORS[key] : undefined;
}

/** True when the matcher has version rules for this ecosystem name. */
export function supportsEcosystem(ecosystem: string): boolean {
  return comparatorFor(ecosystem) !== undefined;
}

// A release-scoped dependency (Debian:12) matches only the doc of its own
// release (ecosystem Debian, ecosystem_qualifier Debian:12). Any other
// dependency matches the stored ecosystem exactly.
function sameEcosystem(ecosystem: string, advisory: Advisory): boolean {
  const base = baseEcosystem(ecosystem);
  if (RELEASE_SCOPED.has(base)) return base === advisory.ecosystem && advisory.ecosystem_qualifier === ecosystem;
  return ecosystem === advisory.ecosystem;
}

function sameName(ecosystem: string, a: string, b: string): boolean {
  if (ecosystem === "PyPI" || ecosystem === "python") return normalizePypiName(a) === normalizePypiName(b);
  return a === b;
}

export function matchAdvisory(dep: Dependency, advisory: Advisory): MatchResult {
  if (!sameEcosystem(dep.ecosystem, advisory) || !sameName(dep.ecosystem, dep.name, advisory.component)) {
    return { affected: false };
  }
  const cmp = comparatorFor(dep.ecosystem);
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
