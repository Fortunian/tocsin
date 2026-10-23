// scripts/gen-skills.mjs: the Codex copy and the Cursor rule come from
// skills/tocsin/SKILL.md, and --check fails when either is stale.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "../../scripts/gen-skills.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/gen-skills.mjs");
const skill = readFileSync(join(ROOT, "skills/tocsin/SKILL.md"), "utf8");
const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill)!;
const description = /^description: (.*)$/m.exec(front)![1];

const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function tempRoot(): string {
  tmp = mkdtempSync(join(tmpdir(), "tocsin-gen-skills-"));
  cpSync(join(ROOT, "skills"), join(tmp, "skills"), { recursive: true });
  return tmp;
}

describe("gen-skills", () => {
  it("render: the Codex copy is the skill; the Cursor rule has the description, alwaysApply: false and the body", () => {
    const out = render(skill) as { codex: string; cursor: string };
    expect(out.codex).toBe(skill);
    expect(out.cursor).toBe(`---\ndescription: ${description}\nalwaysApply: false\n---\n${body}`);
  });

  it("render refuses a skill with no frontmatter or no description", () => {
    expect(() => render("# no frontmatter\n")).toThrow();
    expect(() => render("---\nname: tocsin\n---\nbody\n")).toThrow(/description/);
  });

  it("the committed files match the generator", () => {
    const out = render(skill) as { codex: string; cursor: string };
    expect(readFileSync(join(ROOT, "skills/codex/tocsin/SKILL.md"), "utf8")).toBe(out.codex);
    expect(readFileSync(join(ROOT, "skills/cursor/tocsin.mdc"), "utf8")).toBe(out.cursor);
  });

  it("the repo is fresh: --check exits 0", () => {
    const r = run("--check");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("skills are up to date");
  });

  it("a stale Cursor rule fails --check; gen fixes it", () => {
    const root = tempRoot();
    appendFileSync(join(root, "skills/cursor/tocsin.mdc"), "stale line\n");
    const stale = run("--check", "--root", root);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("skills/cursor/tocsin.mdc is stale. Run: npm run gen:skills");
    expect(run("--root", root).status).toBe(0);
    expect(run("--check", "--root", root).status).toBe(0);
  });

  it("an edited source fails --check; a missing generated file fails --check", () => {
    const root = tempRoot();
    appendFileSync(join(root, "skills/tocsin/SKILL.md"), "\nOne more line.\n");
    const r = run("--check", "--root", root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is stale");
    rmSync(join(root, "skills/codex"), { recursive: true });
    writeFileSync(join(root, "skills/tocsin/SKILL.md"), skill);
    const missing = run("--check", "--root", root);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("skills/codex/tocsin/SKILL.md is stale");
  });

  it("a source with no description exits 1 and writes nothing", () => {
    const root = tempRoot();
    writeFileSync(join(root, "skills/tocsin/SKILL.md"), "---\nname: tocsin\n---\nbody\n");
    const before = readFileSync(join(root, "skills/cursor/tocsin.mdc"), "utf8");
    const r = run("--root", root);
    expect(r.status).toBe(1);
    expect(readFileSync(join(root, "skills/cursor/tocsin.mdc"), "utf8")).toBe(before);
  });
});
