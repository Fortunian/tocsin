// plugins/tocsin/skills/tocsin/SKILL.md comes from skills/tocsin/SKILL.md
// through scripts/gen-skills.mjs, and --check fails when it is stale.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/gen-skills.mjs");
const PLUGIN_SKILL = "plugins/tocsin/skills/tocsin/SKILL.md";
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("plugin skill parity", () => {
  it("the plugin skill is the skill, byte for byte", () => {
    expect(readFileSync(join(ROOT, PLUGIN_SKILL)).equals(readFileSync(join(ROOT, "skills/tocsin/SKILL.md")))).toBe(true);
  });

  it("the repo is fresh: --check exits 0", () => {
    const r = run("--check");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("a stale plugin skill fails --check; gen fixes it", () => {
    tmp = mkdtempSync(join(tmpdir(), "tocsin-plugin-skill-"));
    cpSync(join(ROOT, "skills"), join(tmp, "skills"), { recursive: true });
    cpSync(join(ROOT, "plugins"), join(tmp, "plugins"), { recursive: true });
    expect(run("--check", "--root", tmp).status).toBe(0);
    appendFileSync(join(tmp, PLUGIN_SKILL), "stale line\n");
    const stale = run("--check", "--root", tmp);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(`${PLUGIN_SKILL} is stale. Run: npm run gen:skills`);
    expect(run("--root", tmp).status).toBe(0);
    expect(run("--check", "--root", tmp).status).toBe(0);
    expect(readFileSync(join(tmp, PLUGIN_SKILL)).equals(readFileSync(join(tmp, "skills/tocsin/SKILL.md")))).toBe(true);
  });
});
