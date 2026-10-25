// `tocsin connect` prints the Claude Code plugin install command after it
// wires the Claude Code MCP server, and only then.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { fakeIo, type FakeIo } from "./helpers.tcs-13.js";

const HINT = "claude plugin install tocsin --marketplace Fortunian/tocsin";

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

async function put(home: string, rel: string, text: string): Promise<void> {
  const p = join(home, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
}

describe("connect: Claude Code plugin hint", () => {
  it("--claude-code prints the hint once; a second run prints it again and still ends with the summary line", async () => {
    io = await fakeIo(["connect", "--claude-code"]);
    expect(await main(io)).toBe(0);
    const first = io.text().out;
    expect(first).toContain("Claude Code: connected (");
    expect(first.split(HINT).length - 1).toBe(1);
    io.stdout.length = 0;
    expect(await main(io)).toBe(0);
    const second = io.text().out;
    expect(second).toContain(HINT);
    expect(second.split("\n").at(-1)).toBe("already connected, nothing changed");
  });

  it("detected Claude Code (no flag) prints the hint", async () => {
    io = await fakeIo(["connect"]);
    await put(io.home, ".claude.json", "{}\n");
    expect(await main(io)).toBe(0);
    expect(io.text().out).toContain(HINT);
  });

  it("--cursor only: no hint", async () => {
    io = await fakeIo(["connect", "--cursor"]);
    expect(await main(io)).toBe(0);
    expect(io.text().out).not.toContain(HINT);
  });

  it("--claude-code --dry-run: no hint", async () => {
    io = await fakeIo(["connect", "--claude-code", "--dry-run"]);
    expect(await main(io)).toBe(0);
    expect(io.text().out).not.toContain(HINT);
  });

  it("--print: no hint", async () => {
    io = await fakeIo(["connect", "--print"]);
    expect(await main(io)).toBe(0);
    expect(io.text().out).not.toContain(HINT);
  });

  it("a Claude Code config it cannot parse: no hint", async () => {
    io = await fakeIo(["connect", "--claude-code"]);
    await put(io.home, ".claude.json", '{"mcpServers": {');
    expect(await main(io)).toBe(1);
    expect(io.text().out).not.toContain(HINT);
  });
});
