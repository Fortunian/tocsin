// `tocsin check --summary`: the one line the Claude Code SessionStart hook
// prints. Always exit 0, so the hook never blocks a session.
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { ALL_RUNTIMES_ABSENT, fakeIo, json, type FakeIo } from "./helpers.tcs-13.js";

const FIXTURE = new URL("../fixtures/cli/package-lock.json", import.meta.url);

const item = (i: number, exploited: boolean) => ({
  dependency: { ecosystem: "npm", name: `pkg-${i}`, version: "1.0.0" },
  advisory_id: `tcs_01JA00000000000000000000${i}${i}`,
  severity: { score: 7.2, label: "high" },
  exploited,
  fixed_in: "1.0.1",
  action: "Upgrade.",
});

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

async function setup(argv: string[], answer?: unknown): Promise<FakeIo> {
  io = await fakeIo(["check", ...argv]);
  for (const [k, v] of ALL_RUNTIMES_ABSENT) io.commands.set(k, v);
  await copyFile(FIXTURE, join(io.cwd, "package-lock.json"));
  if (answer !== undefined) io.routes.push((c) => (c.method === "POST" && c.url.pathname === "/v1/check" ? json(answer) : undefined));
  return io;
}

describe("tocsin check --summary", () => {
  it("affected: one line with the counts and exit 1, return 0", async () => {
    const io = await setup(["--summary"], { checked: 10, affected: [item(1, true), item(2, false)], skipped: [], feed_cursor: 7 });
    expect(await main(io)).toBe(0);
    expect(io.stdout).toEqual(["tocsin: 2 affected of 10 checked, 1 exploited (exit 1). Run npx tocsin check --json for details."]);
    expect(io.stderr).toEqual([]);
  });

  it("clean: one line with 0 affected and exit 0", async () => {
    const io = await setup(["--summary"], { checked: 10, affected: [], skipped: [], feed_cursor: 7 });
    expect(await main(io)).toBe(0);
    expect(io.stdout).toEqual(["tocsin: 0 affected of 10 checked (exit 0)"]);
  });

  it("skipped items are named in the line", async () => {
    const io = await setup(["--summary"], { checked: 4, affected: [], skipped: [{ reason: "unsupported" }, { reason: "unsupported" }], feed_cursor: 7 });
    expect(await main(io)).toBe(0);
    expect(io.stdout).toEqual(["tocsin: 0 affected of 4 checked, 2 skipped (exit 0)"]);
  });

  it("network failure: exactly 'tocsin: check failed (network)', return 0, nothing on stderr", async () => {
    const io = await setup(["--summary"]);
    io.routes.push(() => {
      throw new Error("getaddrinfo ENOTFOUND tocsin.sh");
    });
    expect(await main(io)).toBe(0);
    expect(io.stdout).toEqual(["tocsin: check failed (network)"]);
    expect(io.stderr).toEqual([]);
  });

  it("a 500 answer is a failed check too, never clean", async () => {
    const io = await setup(["--summary"]);
    io.routes.push(() => json({ error: "boom" }, 500));
    expect(await main(io)).toBe(0);
    expect(io.stdout).toEqual(["tocsin: check failed (network)"]);
  });

  it("nothing to check: one line with exit 2, return 0", async () => {
    io = await fakeIo(["check", "--summary"]);
    for (const [k, v] of ALL_RUNTIMES_ABSENT) io.commands.set(k, v);
    expect(await main(io)).toBe(0);
    expect(io.stdout).toEqual(["tocsin: nothing to check here (exit 2)"]);
    expect(io.stderr).toEqual([]);
    expect(io.calls).toHaveLength(0);
  });

  it("--json is unchanged on the same fixture: exit 1 and the JSON document", async () => {
    const io = await setup(["--json"], { checked: 10, affected: [item(1, true), item(2, false)], skipped: [], feed_cursor: 7 });
    expect(await main(io)).toBe(1);
    expect(io.stdout).toHaveLength(1);
    const doc = JSON.parse(io.stdout[0]);
    expect(doc.checked).toBe(10);
    expect(doc.affected).toHaveLength(2);
  });
});

describe("tocsin check --summary, an unexpected error", () => {
  it("an unreadable cwd prints one failed line and returns 0", async () => {
    io = await fakeIo(["check", "--summary"]);
    for (const [k, v] of ALL_RUNTIMES_ABSENT) io.commands.set(k, v);
    io.cwd = join(io.cwd, "missing-dir");
    expect(await main(io)).toBe(0);
    expect(io.stdout).toHaveLength(1);
    expect(io.stdout[0]).toMatch(/^tocsin: check failed \(.*ENOENT.*\)$/);
  });
});
