// Lockfile discovery, shared by the CLI (`tocsin check`) and the GitHub Action
// (action/check.mjs). It is plain JavaScript with JSDoc types on purpose: the
// Action runs it with the runner's `node` straight from the checkout, with no
// build step and no package install. tsc type-checks it (checkJs) and copies it
// into dist for the npm package.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// The same names src/check/parsers/index.ts:detectParser accepts.
/** @type {readonly string[]} */
export const LOCKFILE_NAMES = Object.freeze([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "go.sum",
  "composer.lock",
  "cargo.lock",
  "gemfile.lock",
]);

const NAMES = new Set(LOCKFILE_NAMES);

/**
 * True when the base name is a lockfile the check endpoint parses (case-insensitive).
 * @param {string} name
 * @returns {boolean}
 */
export function isLockfileName(name) {
  const base = name.toLowerCase();
  return NAMES.has(base) || /^requirements[-_.][^/]*\.txt$/.test(base);
}

/**
 * The lockfiles at the top level of `dir`, sorted by name, with their text.
 * @param {string} dir
 * @returns {Promise<{ name: string; text: string }[]>}
 */
export async function findLockfiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries.filter((e) => e.isFile() && isLockfileName(e.name)).map((e) => e.name).sort();
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(dir, name), "utf8") })));
}
