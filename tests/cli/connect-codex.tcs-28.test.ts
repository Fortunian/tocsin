// `tocsin connect --codex` installs the Tocsin skill for Codex at
// ~/.codex/skills/tocsin/SKILL.md, through the production entry (main).
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { fakeIo, snapshot, type FakeIo } from "./helpers.tcs-13.js";

const REPO_SKILL = new URL("../../skills/tocsin/SKILL.md", import.meta.url);
const SKILL_REL = ".codex/skills/tocsin/SKILL.md";

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

async function put(home: string, rel: string, data: string | Buffer): Promise<string> {
  const p = join(home, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
  return p;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("tocsin connect: Codex skill", () => {
  it("writes the skill", async () => {
    io = await fakeIo(["connect", "--codex"]);
    await put(io.home, ".codex/config.toml", 'model = "fixture"\n');
    expect(await main(io)).toBe(0);
    const path = join(io.home, SKILL_REL);
    expect((await readFile(path)).equals(await readFile(REPO_SKILL))).toBe(true);
    expect(io.text().out).toContain(`Codex skill: installed (${path})`);
  });

  it("auto-detect: a home with only ~/.codex/ gets the skill", async () => {
    io = await fakeIo(["connect"]);
    await mkdir(join(io.home, ".codex"));
    expect(await main(io)).toBe(0);
    expect((await readFile(join(io.home, SKILL_REL))).equals(await readFile(REPO_SKILL))).toBe(true);
  });

  it("second run: already installed, nothing written", async () => {
    io = await fakeIo(["connect", "--codex"]);
    await put(io.home, ".codex/config.toml", "");
    expect(await main(io)).toBe(0);
    const before = await snapshot(io.home);
    await wait(20);
    io.stdout.length = 0;
    expect(await main(io)).toBe(0);
    expect(await snapshot(io.home)).toEqual(before);
    const out = io.text().out;
    expect(out).toContain(`Codex skill: already installed (${join(io.home, SKILL_REL)})`);
    expect(out.split("\n").at(-1)).toBe("already connected, nothing changed");
  });

  it("user-edited: left byte-identical, the path is printed, exit 0", async () => {
    io = await fakeIo(["connect", "--codex"]);
    const path = await put(io.home, SKILL_REL, "my own notes about tocsin\n");
    const before = await stat(path);
    await wait(20);
    expect(await main(io)).toBe(0);
    expect(await readFile(path, "utf8")).toBe("my own notes about tocsin\n");
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(io.text().out).toContain(`Codex skill: ${path} differs from ours (edited?), left as is`);
  });

  it("CRLF copy is different and is not replaced", async () => {
    io = await fakeIo(["connect", "--codex"]);
    const crlf = (await readFile(REPO_SKILL, "utf8")).replace(/\n/g, "\r\n");
    const path = await put(io.home, SKILL_REL, crlf);
    expect(await main(io)).toBe(0);
    expect(await readFile(path, "utf8")).toBe(crlf);
    expect(io.text().out).toContain("differs from ours");
  });

  it("the skill path is a directory: failed, exit 1, the Codex MCP config still written", async () => {
    io = await fakeIo(["connect", "--codex"]);
    await mkdir(join(io.home, SKILL_REL), { recursive: true });
    expect(await main(io)).toBe(1);
    expect(io.text().out).toMatch(/Codex skill: could not read/);
    expect(await readFile(join(io.home, ".codex/config.toml"), "utf8")).toContain("[mcp_servers.tocsin]");
  });

  it("--dry-run writes no skill", async () => {
    io = await fakeIo(["connect", "--codex", "--dry-run"]);
    expect(await main(io)).toBe(0);
    expect(await snapshot(io.home)).toEqual(new Map());
    expect(io.text().out).toContain(`would write ${join(io.home, SKILL_REL)}`);
  });
});
