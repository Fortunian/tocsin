// `tocsin connect --cursor` installs the Tocsin skill as a Cursor rule at
// ~/.cursor/rules/tocsin.mdc, through the production entry (main).
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { fakeIo, snapshot, type FakeIo } from "./helpers.tcs-13.js";

const skill = await readFile(new URL("../../skills/tocsin/SKILL.md", import.meta.url), "utf8");
const [, skillFront, skillBody] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill)!;
const description = /^description: (.*)$/m.exec(skillFront)![1];
const RULE_REL = ".cursor/rules/tocsin.mdc";

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("tocsin connect: Cursor rule", () => {
  it("writes the rule with description and alwaysApply: false and the skill body", async () => {
    io = await fakeIo(["connect", "--cursor"]);
    await mkdir(join(io.home, ".cursor"));
    expect(await main(io)).toBe(0);
    const path = join(io.home, RULE_REL);
    const rule = await readFile(path, "utf8");
    expect(rule.startsWith("---\n")).toBe(true);
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(rule)!;
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(new RegExp(`^description: ${description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    expect(m[1]).toMatch(/^alwaysApply: false$/m);
    expect(m[1]).not.toMatch(/^name:/m);
    expect(m[2]).toBe(skillBody);
    expect(io.text().out).toContain(`Cursor rule: installed (${path})`);
  });

  it("auto-detect: a home with ~/.cursor/ gets the rule", async () => {
    io = await fakeIo(["connect"]);
    await mkdir(join(io.home, ".cursor"));
    expect(await main(io)).toBe(0);
    expect(await readFile(join(io.home, RULE_REL), "utf8")).toContain("alwaysApply: false");
  });

  it("second run: already installed, nothing written", async () => {
    io = await fakeIo(["connect", "--cursor"]);
    expect(await main(io)).toBe(0);
    const before = await snapshot(io.home);
    await wait(20);
    io.stdout.length = 0;
    expect(await main(io)).toBe(0);
    expect(await snapshot(io.home)).toEqual(before);
    expect(io.text().out).toContain(`Cursor rule: already installed (${join(io.home, RULE_REL)})`);
  });

  it("user-edited: left byte-identical, the path is printed", async () => {
    io = await fakeIo(["connect", "--cursor"]);
    const path = join(io.home, RULE_REL);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "---\ndescription: mine\nalwaysApply: true\n---\nmy rule\n");
    const before = await stat(path);
    await wait(20);
    expect(await main(io)).toBe(0);
    expect(await readFile(path, "utf8")).toBe("---\ndescription: mine\nalwaysApply: true\n---\nmy rule\n");
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(io.text().out).toContain(`Cursor rule: ${path} differs from ours (edited?), left as is`);
  });
});
