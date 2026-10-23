import { parseCargoLock } from "./cargo-lock";
import { parseComposerLock } from "./composer-lock";
import { parseGemfileLock } from "./gemfile-lock";
import { parseGoSum } from "./go-sum";
import { parseGradleLockfile } from "./gradle-lockfile";
import { parseMixLock } from "./mix-lock";
import { parseNugetLock } from "./nuget-lock";
import { parsePackageLock } from "./package-lock";
import { parsePnpmLock } from "./pnpm-lock";
import { parsePomXml } from "./pom-xml";
import { parsePubspecLock } from "./pubspec-lock";
import { parseRequirements } from "./requirements";
import type { ParseResult, ParserId } from "./types";
import { parseYarnLock } from "./yarn-lock";

export * from "./types";
export { parsePackageLock } from "./package-lock";
export { parsePnpmLock } from "./pnpm-lock";
export { parseYarnLock } from "./yarn-lock";
export { parseRequirements } from "./requirements";
export { parseGoSum } from "./go-sum";
export { parseComposerLock } from "./composer-lock";
export { parseCargoLock } from "./cargo-lock";
export { parseGemfileLock } from "./gemfile-lock";
export { parseRuntimes } from "./runtimes";
export { parsePomXml } from "./pom-xml";
export { parseGradleLockfile } from "./gradle-lockfile";
export { parseNugetLock } from "./nuget-lock";
export { parseMixLock } from "./mix-lock";
export { parsePubspecLock } from "./pubspec-lock";
export { parseOsPackages } from "./os-packages";

// os-packages takes a release too; the check route calls parseOsPackages itself.
const PARSERS: Record<Exclude<ParserId, "os-packages">, (text: string) => ParseResult> = {
  "package-lock": parsePackageLock,
  "pnpm-lock": parsePnpmLock,
  "yarn-lock": parseYarnLock,
  requirements: parseRequirements,
  "go-sum": parseGoSum,
  "composer-lock": parseComposerLock,
  "cargo-lock": parseCargoLock,
  "gemfile-lock": parseGemfileLock,
  "pom-xml": parsePomXml,
  "gradle-lockfile": parseGradleLockfile,
  "nuget-lock": parseNugetLock,
  "mix-lock": parseMixLock,
  "pubspec-lock": parsePubspecLock,
};

const BY_NAME: Record<string, Exclude<ParserId, "os-packages">> = {
  "package-lock.json": "package-lock",
  "npm-shrinkwrap.json": "package-lock",
  "pnpm-lock.yaml": "pnpm-lock",
  "yarn.lock": "yarn-lock",
  "requirements.txt": "requirements",
  "go.sum": "go-sum",
  "composer.lock": "composer-lock",
  "cargo.lock": "cargo-lock",
  "gemfile.lock": "gemfile-lock",
  "pom.xml": "pom-xml",
  "gradle.lockfile": "gradle-lockfile",
  "packages.lock.json": "nuget-lock",
  "mix.lock": "mix-lock",
  "pubspec.lock": "pubspec-lock",
};

/** Lockfile names the check endpoint accepts, for its 400 answer. */
export const SUPPORTED_FILENAMES: readonly string[] = [...Object.keys(BY_NAME), "requirements-*.txt"];

/** Picks the parser from the file's basename (case-insensitive) and runs it. Unknown filename: null. */
export function detectParser(filename: string): Exclude<ParserId, "os-packages"> | null {
  const base = filename.split(/[\\/]/).pop()!.toLowerCase();
  if (base in BY_NAME) return BY_NAME[base];
  if (/^requirements[-_.][^/]*\.txt$/.test(base)) return "requirements";
  return null;
}

export function detect(filename: string, text: string): { parser: ParserId; result: ParseResult } | null {
  const parser = detectParser(filename);
  return parser === null ? null : { parser, result: PARSERS[parser](text) };
}
