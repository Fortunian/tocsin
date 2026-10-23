// Turns skills/tocsin/SKILL.md, the one source of the skill text, into the
// copies other agent tools read. The CLI package ships all three.
//   skills/codex/tocsin/SKILL.md   Codex skill: the same file, byte for byte
//   skills/cursor/tocsin.mdc       Cursor rule: description + alwaysApply: false, then the body
//
//   npm run gen:skills              write both files
//   npm run gen:skills -- --check   exit 1 if either committed file is stale
//   --root <dir>                    run on another checkout (tests)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = "skills/tocsin/SKILL.md";
/** @type {{ codex: string; cursor: string }} */
const OUTS = { codex: "skills/codex/tocsin/SKILL.md", cursor: "skills/cursor/tocsin.mdc" };
const KEYS = /** @type {const} */ (["codex", "cursor"]);

/**
 * The generated files for one SKILL.md text. Throws when the frontmatter has no description.
 * @param {string} skill
 * @returns {{ codex: string; cursor: string }}
 */
export function render(skill) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(skill);
  if (!m) throw new Error(`${SRC} has no frontmatter`);
  const description = /^description:[ \t]*(\S.*?)[ \t]*$/m.exec(m[1])?.[1];
  if (!description) throw new Error(`${SRC} frontmatter has no description`);
  return {
    codex: skill,
    cursor: `---\ndescription: ${description}\nalwaysApply: false\n---\n${m[2]}`,
  };
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
  const at = argv.indexOf("--root");
  const root = at >= 0 ? resolve(argv[at + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let files;
  try {
    files = render(readFileSync(resolve(root, SRC), "utf8"));
  } catch (e) {
    console.error(`gen-skills: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (argv.includes("--check")) {
    let stale = 0;
    for (const k of KEYS) {
      const rel = OUTS[k];
      let current = null;
      try {
        current = readFileSync(resolve(root, rel), "utf8");
      } catch {
        // missing file counts as stale
      }
      if (current !== files[k]) {
        console.error(`${rel} is stale. Run: npm run gen:skills`);
        stale++;
      }
    }
    if (stale > 0) return 1;
    console.log("skills are up to date");
    return 0;
  }
  for (const k of KEYS) {
    const p = resolve(root, OUTS[k]);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, files[k]);
    console.log(`wrote ${p}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
