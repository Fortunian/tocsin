import { parseCargoLock } from "./cargo-lock";
import { parseComposerLock } from "./composer-lock";
import { parseGemfileLock } from "./gemfile-lock";
import { parseGoSum } from "./go-sum";
import { parsePackageLock } from "./package-lock";
import { parsePnpmLock } from "./pnpm-lock";
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

const PARSERS: Record<ParserId, (text: string) => ParseResult> = {
  "package-lock": parsePackageLock,
  "pnpm-lock": parsePnpmLock,
  "yarn-lock": parseYarnLock,
  requirements: parseRequirements,
  "go-sum": parseGoSum,
  "composer-lock": parseComposerLock,
  "cargo-lock": parseCargoLock,
  "gemfile-lock": parseGemfileLock,
};

const BY_NAME: Record<string, ParserId> = {
  "package-lock.json": "package-lock",
  "npm-shrinkwrap.json": "package-lock",
  "pnpm-lock.yaml": "pnpm-lock",
  "yarn.lock": "yarn-lock",
  "requirements.txt": "requirements",
  "go.sum": "go-sum",
  "composer.lock": "composer-lock",
  "cargo.lock": "cargo-lock",
  "gemfile.lock": "gemfile-lock",
};

/** Picks the parser from the file's basename (case-insensitive) and runs it. Unknown filename: null. */
export function detectParser(filename: string): ParserId | null {
  const base = filename.split(/[\\/]/).pop()!.toLowerCase();
  if (base in BY_NAME) return BY_NAME[base];
  if (/^requirements[-_.][^/]*\.txt$/.test(base)) return "requirements";
  return null;
}

export function detect(filename: string, text: string): { parser: ParserId; result: ParseResult } | null {
  const parser = detectParser(filename);
  return parser === null ? null : { parser, result: PARSERS[parser](text) };
}
