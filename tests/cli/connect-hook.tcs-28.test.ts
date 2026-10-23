// `tocsin connect --claude-code --hook` adds one SessionStart hook to
// ~/.claude/settings.json, through the production entry (main).
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { HOOK_COMMAND } from "../../packages/cli/src/connect.js";
import { fakeIo, firstJsonBlock, snapshot, type FakeIo } from "./helpers.tcs-13.js";

const SETTINGS_REL = ".claude/settings.json";

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

async function put(home: string, rel: string, text: string): Promise<string> {
  const p = join(home, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
  return p;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8"));
const commands = (entries: { hooks: { command: string }[] }[]) => entries.flatMap((e) => e.hooks.map((h) => h.command));

const PRE_TOOL_USE = [{ matcher: "Bash", hooks: [{ type: "command", command: "echo tocsin" }] }];
const USER_START = { matcher: "startup", hooks: [{ type: "command", command: "echo hello" }] };

describe("tocsin connect --hook", () => {
  it("the hook command runs the one-line summary check", () => {
    expect(HOOK_COMMAND).toBe("npx -y tocsin check --summary");
  });

  it("adds one SessionStart entry and keeps every other key", async () => {
    io = await fakeIo(["connect", "--claude-code", "--hook"]);
    const path = await put(io.home, SETTINGS_REL, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: PRE_TOOL_USE }, model: "fixture" }, null, 2) + "\n");
    expect(await main(io)).toBe(0);
    const s = await readJson(path);
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0]).toEqual({ matcher: "startup", hooks: [{ type: "command", command: HOOK_COMMAND }] });
    expect(s.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(s.hooks.PreToolUse).toEqual(PRE_TOOL_USE);
    expect(s.model).toBe("fixture");
    expect((await readFile(path, "utf8")).endsWith("}\n")).toBe(true);
    expect(io.text().out).toContain(`Claude Code hook: connected (${path})`);
  });

  it("creates settings.json when it is absent", async () => {
    io = await fakeIo(["connect", "--claude-code", "--hook"]);
    expect(await main(io)).toBe(0);
    const s = await readJson(join(io.home, SETTINGS_REL));
    expect(commands(s.hooks.SessionStart)).toEqual([HOOK_COMMAND]);
  });

  it("keeps a user SessionStart hook first and appends ours", async () => {
    io = await fakeIo(["connect", "--claude-code", "--hook"]);
    const path = await put(io.home, SETTINGS_REL, JSON.stringify({ hooks: { SessionStart: [USER_START] } }));
    expect(await main(io)).toBe(0);
    const s = await readJson(path);
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart[0]).toEqual(USER_START);
    expect(commands(s.hooks.SessionStart)).toEqual(["echo hello", HOOK_COMMAND]);
  });

  it("our command in PreToolUse does not count: ours is added to SessionStart", async () => {
    io = await fakeIo(["connect", "--claude-code", "--hook"]);
    const pre = [{ matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND }] }];
    const path = await put(io.home, SETTINGS_REL, JSON.stringify({ hooks: { PreToolUse: pre } }));
    expect(await main(io)).toBe(0);
    const s = await readJson(path);
    expect(s.hooks.PreToolUse).toEqual(pre);
    expect(commands(s.hooks.SessionStart)).toEqual([HOOK_COMMAND]);
  });

  it("second run: settings.json bytes and mtime unchanged", async () => {
    io = await fakeIo(["connect", "--claude-code", "--hook"]);
    const path = await put(io.home, SETTINGS_REL, "{}\n");
    expect(await main(io)).toBe(0);
    const before = await snapshot(io.home);
    await wait(20);
    io.stdout.length = 0;
    expect(await main(io)).toBe(0);
    expect(await snapshot(io.home)).toEqual(before);
    expect(io.text().out).toContain(`Claude Code hook: already connected (${path})`);
    expect(io.text().out.split("\n").at(-1)).toBe("already connected, nothing changed");
  });

  it("our command with no matcher counts as ours", async () => {
    io = await fakeIo(["connect", "--claude-code", "--hook"]);
    const text = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }] } });
    const path = await put(io.home, SETTINGS_REL, text);
    expect(await main(io)).toBe(0);
    expect(await readFile(path, "utf8")).toBe(text);
    expect(io.text().out).toContain("Claude Code hook: already connected");
  });

  it("no --hook: settings.json byte-identical, and an absent one stays absent", async () => {
    io = await fakeIo(["connect", "--claude-code"]);
    const path = await put(io.home, SETTINGS_REL, '{"model":"fixture"}');
    const before = await stat(path);
    await wait(20);
    expect(await main(io)).toBe(0);
    expect(await readFile(path, "utf8")).toBe('{"model":"fixture"}');
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(io.text().out).not.toContain("hook");
    await io.cleanup();

    io = await fakeIo(["connect", "--claude-code"]);
    expect(await main(io)).toBe(0);
    expect(existsSync(join(io.home, SETTINGS_REL))).toBe(false);
  });

  it("malformed settings.json: byte-identical, exit 1, the hook block printed", async () => {
    io = await fakeIo(["connect", "--claude-code", "--hook"]);
    const path = await put(io.home, SETTINGS_REL, '{"hooks": {');
    const before = await stat(path);
    await wait(20);
    expect(await main(io)).toBe(1);
    expect(await readFile(path, "utf8")).toBe('{"hooks": {');
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    const out = io.text().out;
    expect(out).toContain(path);
    expect(out).toContain("SessionStart");
    expect(out).toContain(HOOK_COMMAND);
    const block = firstJsonBlock(out) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    expect(commands(block.hooks.SessionStart)).toEqual([HOOK_COMMAND]);
  });

  for (const text of ['{"hooks":[]}', '{"hooks":"x"}', '{"hooks":{"SessionStart":{}}}', "[]", '{"a":1} trailing']) {
    it(`a settings.json of shape ${text} is left byte-identical, exit 1`, async () => {
      io = await fakeIo(["connect", "--claude-code", "--hook"]);
      const path = await put(io.home, SETTINGS_REL, text);
      expect(await main(io)).toBe(1);
      expect(await readFile(path, "utf8")).toBe(text);
      expect(io.text().out).toContain("could not parse");
    });
  }

  for (const near of ["npx tocsin check --json", "npx -y tocsin check --summary --json"]) {
    it(`a near-miss command (${near}) is different: nothing appended`, async () => {
      io = await fakeIo(["connect", "--claude-code", "--hook"]);
      const text = JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: near }] }] } });
      const path = await put(io.home, SETTINGS_REL, text);
      expect(await main(io)).toBe(0);
      expect(await readFile(path, "utf8")).toBe(text);
      const out = io.text().out;
      expect(out).toContain(`Claude Code hook: ${path} has a different tocsin hook, left as is`);
      expect(out).toContain(HOOK_COMMAND);
    });
  }

  it("a BOM at the start is stripped like the MCP config", async () => {
    io = await fakeIo(["connect", "--claude-code", "--hook"]);
    const path = await put(io.home, SETTINGS_REL, '﻿{"model":"fixture"}\n');
    expect(await main(io)).toBe(0);
    const s = await readJson(path);
    expect(s.model).toBe("fixture");
    expect(commands(s.hooks.SessionStart)).toEqual([HOOK_COMMAND]);
  });

  it("--dry-run: nothing written, the edit printed", async () => {
    io = await fakeIo(["connect", "--claude-code", "--hook", "--dry-run"]);
    await put(io.home, SETTINGS_REL, "{}\n");
    const before = await snapshot(io.home);
    expect(await main(io)).toBe(0);
    expect(await snapshot(io.home)).toEqual(before);
    const out = io.text().out;
    expect(out).toContain(`would write ${join(io.home, SETTINGS_REL)}`);
    expect(out).toContain('"SessionStart"');
    expect(out).toContain(HOOK_COMMAND);
  });

  it("--hook with only --cursor does not touch settings.json", async () => {
    io = await fakeIo(["connect", "--cursor", "--hook"]);
    expect(await main(io)).toBe(0);
    expect(existsSync(join(io.home, SETTINGS_REL))).toBe(false);
  });
});
