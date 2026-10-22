import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync(new URL("../../skills/tocsin/SKILL.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../../packages/cli/package.json", import.meta.url), "utf8"));

describe("skills/tocsin/SKILL.md", () => {
  const m = skill.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  it("has name and description frontmatter", () => {
    expect(m).not.toBeNull();
    const front = m![1];
    expect(front).toMatch(/^name: tocsin$/m);
    expect(front).toMatch(/^description: \S.{20,}$/m);
  });

  it("says when to run the check and how to read it", () => {
    const body = m![2];
    for (const s of ["npx tocsin check", "session start", "deploy", "headline", "--json", "affected", "skipped", "feed_cursor", "fixed_in"]) {
      expect(body).toContain(s);
    }
    for (const code of ["0", "1", "2", "3"]) expect(body).toMatch(new RegExp("`" + code + "`"));
  });
});

describe("packages/cli/package.json", () => {
  it("is the tocsin bin with no runtime dependencies", () => {
    expect(pkg.name).toBe("tocsin");
    expect(pkg.bin.tocsin).toBe("bin/tocsin.js");
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(pkg.files).toContain("skills");
    expect(pkg.engines.node).toBe(">=20");
  });
});

describe("tocsin entry point", () => {
  it("--help exits 0; no command or an unknown command exits 2 with usage on stderr", async () => {
    const { main } = await import("../../packages/cli/src/cli.js");
    const { fakeIo } = await import("./helpers.tcs-13.js");
    for (const [argv, code, stream] of [[["--help"], 0, "out"], [[], 2, "err"], [["nope"], 2, "err"]] as const) {
      const io = await fakeIo([...argv]);
      expect(await main(io)).toBe(code);
      expect(io.text()[stream]).toContain("Usage: tocsin");
      await io.cleanup();
    }
  });
});
