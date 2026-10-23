// `tocsin connect --print-agents-md` prints the AGENTS.md block and writes nothing.
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { fakeIo, snapshot, type FakeIo } from "./helpers.tcs-13.js";

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

describe("tocsin connect --print-agents-md", () => {
  it("prints the 6-line block and writes nothing", async () => {
    io = await fakeIo(["connect", "--print-agents-md"]);
    // A home with every tool present: a normal connect would write to each.
    for (const d of [".codex", ".cursor", ".claude"]) await import("node:fs/promises").then((f) => f.mkdir(`${io!.home}/${d}`));
    const [home, cwd] = [await snapshot(io.home), await snapshot(io.cwd)];
    expect(await main(io)).toBe(0);
    const out = io.text().out;
    expect(out.split("\n")).toHaveLength(6);
    expect(out.split("\n")[0]).toBe("## Security advisories (Tocsin)");
    for (const s of ["npx tocsin check --json", "session start", "deploy", "fixed_in", "Exit 3"]) expect(out).toContain(s);
    expect(await snapshot(io.home)).toEqual(home);
    expect(await snapshot(io.cwd)).toEqual(cwd);
    expect(io.text().err).toBe("");
  });

  it("works with HOME unset", async () => {
    io = await fakeIo(["connect", "--print-agents-md"]);
    delete io.env.HOME;
    expect(await main(io)).toBe(0);
    expect(io.text().out).toContain("npx tocsin check --json");
  });
});

describe("the AGENTS.md block in the docs", () => {
  it("docs/API.md and README.md show the same block the CLI prints", async () => {
    const { readFile } = await import("node:fs/promises");
    const { AGENTS_MD_BLOCK } = await import("../../packages/cli/src/connect.js");
    for (const doc of ["../../docs/API.md", "../../README.md"]) {
      const text = await readFile(new URL(doc, import.meta.url), "utf8");
      expect(text).toContain("```\n" + AGENTS_MD_BLOCK + "\n```");
      expect(text).toContain("npx tocsin connect --codex");
    }
  });
});
