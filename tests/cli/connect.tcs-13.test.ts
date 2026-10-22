import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { fakeIo, firstJsonBlock, snapshot, type FakeIo } from "./helpers.tcs-13.js";

const MCP_URL = "https://mcp.tocsin.sh/mcp";
const REPO_SKILL = new URL("../../skills/tocsin/SKILL.md", import.meta.url);

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

const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function homeWithClaudeAndCursor(argv: string[] = ["connect"]): Promise<FakeIo> {
  io = await fakeIo(argv, { TOCSIN_API_KEY: "tcs_fixture_key" });
  await put(io.home, ".claude.json", '{"numStartups":3}\n');
  await put(io.home, ".cursor/mcp.json", '{"mcpServers":{}}');
  return io;
}

describe("tocsin connect", () => {
  it("wires claude code and cursor", async () => {
    const io = await homeWithClaudeAndCursor();
    expect(await main(io)).toBe(0);
    const claude = await readJson(join(io.home, ".claude.json"));
    expect(claude.numStartups).toBe(3);
    expect(claude.mcpServers.tocsin).toEqual({ type: "http", url: MCP_URL });
    const cursor = await readJson(join(io.home, ".cursor/mcp.json"));
    expect(cursor.mcpServers.tocsin.url).toBe(MCP_URL);
    const skill = await readFile(join(io.home, ".claude/skills/tocsin/SKILL.md"));
    expect(skill.equals(await readFile(REPO_SKILL))).toBe(true);
    expect(io.text().out).toContain(`Claude Code: connected (${join(io.home, ".claude.json")})`);
    for (const rel of [".claude.json", ".cursor/mcp.json"]) {
      expect(await readFile(join(io.home, rel), "utf8")).not.toContain("tcs_fixture_key");
    }
  });

  it("second run: already connected, mtime unchanged", async () => {
    const io = await homeWithClaudeAndCursor();
    expect(await main(io)).toBe(0);
    const before = await snapshot(io.home);
    expect(before.size).toBeGreaterThanOrEqual(3);
    await wait(20);
    io.stdout.length = 0;
    expect(await main(io)).toBe(0);
    const after = await snapshot(io.home);
    expect(after).toEqual(before);
    const out = io.text().out;
    expect(out).toContain("already connected");
    expect(out.split("\n").at(-1)).toBe("already connected, nothing changed");
    expect(out).not.toMatch(/: connected \(/);
  });

  it("malformed claude.json byte-identical", async () => {
    io = await fakeIo(["connect"]);
    const claudePath = await put(io.home, ".claude.json", '{"mcpServers": {');
    await put(io.home, ".cursor/mcp.json", '{"mcpServers":{}}');
    const before = await stat(claudePath);
    await wait(20);
    expect(await main(io)).toBe(1);
    expect(await readFile(claudePath, "utf8")).toBe('{"mcpServers": {');
    expect((await stat(claudePath)).mtimeMs).toBe(before.mtimeMs);
    const out = io.text().out;
    expect(out).toContain(claudePath);
    const block = firstJsonBlock(out) as { mcpServers: { tocsin: { url: string } } };
    expect(block.mcpServers.tocsin.url).toBe(MCP_URL);
    expect((await readJson(join(io.home, ".cursor/mcp.json"))).mcpServers.tocsin.url).toBe(MCP_URL);
  });

  it("different tocsin entry left as is", async () => {
    io = await fakeIo(["connect", "--claude-code"]);
    const text = '{"mcpServers":{"tocsin":{"url":"https://other"}}}';
    const p = await put(io.home, ".claude.json", text);
    expect(await main(io)).toBe(0);
    expect(await readFile(p, "utf8")).toBe(text);
    expect(io.text().out).toContain("different");
    expect(io.text().out).not.toContain("already connected");
  });

  it("adds tocsin beside near-miss keys, never matches them", async () => {
    io = await fakeIo(["connect", "--claude-code"]);
    const p = await put(io.home, ".claude.json", '{"tocsin":{"type":"http","url":"https://mcp.tocsin.sh/mcp"},"mcpServers":{"tocsin-dev":{"url":"x"},"Tocsin":{"url":"y"}}}');
    expect(await main(io)).toBe(0);
    const obj = await readJson(p);
    expect(obj.mcpServers.tocsin).toEqual({ type: "http", url: MCP_URL });
    expect(obj.mcpServers["tocsin-dev"]).toEqual({ url: "x" });
    expect(obj.mcpServers.Tocsin).toEqual({ url: "y" });
    expect(io.text().out).toContain("Claude Code: connected");
  });

  it("--cursor touches only cursor", async () => {
    const io = await homeWithClaudeAndCursor(["connect", "--cursor"]);
    const claudePath = join(io.home, ".claude.json");
    const before = await stat(claudePath);
    await wait(20);
    expect(await main(io)).toBe(0);
    expect(await readFile(claudePath, "utf8")).toBe('{"numStartups":3}\n');
    expect((await stat(claudePath)).mtimeMs).toBe(before.mtimeMs);
    expect((await readJson(join(io.home, ".cursor/mcp.json"))).mcpServers.tocsin.url).toBe(MCP_URL);
    await expect(stat(join(io.home, ".claude/skills/tocsin/SKILL.md"))).rejects.toThrow();
  });

  it("--dry-run writes nothing", async () => {
    const io = await homeWithClaudeAndCursor(["connect", "--dry-run"]);
    const before = await snapshot(io.home);
    await wait(20);
    expect(await main(io)).toBe(0);
    expect(await snapshot(io.home)).toEqual(before);
    const out = io.text().out;
    expect(out).toContain(`would write ${join(io.home, ".claude.json")}`);
    expect(out).toContain(`would write ${join(io.home, ".cursor/mcp.json")}`);
    expect(out).toContain(`would write ${join(io.home, ".claude/skills/tocsin/SKILL.md")}`);
  });

  it("--print", async () => {
    const io = await homeWithClaudeAndCursor(["connect", "--print"]);
    const before = await snapshot(io.home);
    expect(await main(io)).toBe(0);
    const doc = JSON.parse(io.text().out);
    expect(doc.mcpServers.tocsin.url).toBe(MCP_URL);
    expect(await snapshot(io.home)).toEqual(before);
  });

  it("TOCSIN_MCP_URL overrides the server url", async () => {
    io = await fakeIo(["connect", "--print"], { TOCSIN_MCP_URL: "https://mcp.example.test/mcp" });
    expect(await main(io)).toBe(0);
    expect(JSON.parse(io.text().out).mcpServers.tocsin.url).toBe("https://mcp.example.test/mcp");
  });

  it("claude desktop macOS path", async () => {
    io = await fakeIo(["connect"]);
    await mkdir(join(io.home, "Library/Application Support/Claude"), { recursive: true });
    expect(await main(io)).toBe(0);
    const cfg = await readJson(join(io.home, "Library/Application Support/Claude/claude_desktop_config.json"));
    expect(cfg.mcpServers.tocsin.args).toContain(MCP_URL);
    expect(cfg.mcpServers.tocsin.command).toBe("npx");
  });

  it("claude desktop Windows path", async () => {
    io = await fakeIo(["connect", "--claude-desktop"]);
    io.platform = "win32";
    const appdata = join(io.home, "AppData", "Roaming");
    io.env.APPDATA = appdata;
    expect(await main(io)).toBe(0);
    const cfg = await readJson(join(appdata, "Claude", "claude_desktop_config.json"));
    expect(cfg.mcpServers.tocsin.args).toContain(MCP_URL);
  });

  it("codex appends table once", async () => {
    io = await fakeIo(["connect"]);
    const p = await put(io.home, ".codex/config.toml", 'model = "x"\n');
    expect(await main(io)).toBe(0);
    const text = await readFile(p, "utf8");
    expect(text.startsWith('model = "x"\n')).toBe(true);
    expect(text.match(/\[mcp_servers\.tocsin\]/g)).toHaveLength(1);
    expect(text).toContain(`url = "${MCP_URL}"`);
    const before = await stat(p);
    await wait(20);
    expect(await main(io)).toBe(0);
    expect(await readFile(p, "utf8")).toBe(text);
    expect((await stat(p)).mtimeMs).toBe(before.mtimeMs);
    expect(io.text().out).toContain("Codex: already connected");
  });

  it("codex: a comment or a near-miss table is not a match; a quoted key is", async () => {
    io = await fakeIo(["connect", "--codex"]);
    const p = await put(io.home, ".codex/config.toml", '# [mcp_servers.tocsin]\n[mcp_servers.tocsin_old]\nurl = "y"\n');
    expect(await main(io)).toBe(0);
    expect((await readFile(p, "utf8")).match(/^\[mcp_servers\.tocsin\]$/gm)).toHaveLength(1);

    const quoted = `[mcp_servers."tocsin"]\nurl = "${MCP_URL}"\n`;
    await writeFile(p, quoted);
    io.stdout.length = 0;
    expect(await main(io)).toBe(0);
    expect(await readFile(p, "utf8")).toBe(quoted);
    expect(io.text().out).toContain("already connected");
  });

  it("no agent tool found", async () => {
    io = await fakeIo(["connect"]);
    expect(await main(io)).toBe(0);
    const out = io.text().out;
    expect(out).toContain("no agent tool found");
    expect((firstJsonBlock(out) as { mcpServers: { tocsin: { url: string } } }).mcpServers.tocsin.url).toBe(MCP_URL);
    expect((await snapshot(io.home)).size).toBe(0);
  });

  it("an unknown flag is a usage error", async () => {
    io = await fakeIo(["connect", "--vscode"]);
    expect(await main(io)).toBe(2);
    expect(io.text().err).toContain("Usage:");
  });
});
