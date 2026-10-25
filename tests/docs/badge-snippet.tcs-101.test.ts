import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// TCS-101: README.md, action/README.md and docs/API.md carry the per-repo
// badge snippet and the workflow it needs (id-token: write, on push).
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const SNIPPET = "[![tocsin](https://tocsin.sh/badge/<owner>/<repo>.svg)](https://tocsin.sh)";

describe("badge snippet", () => {
  for (const file of ["README.md", "action/README.md", "docs/API.md"]) {
    it(`${file} has the snippet and id-token: write`, () => {
      const text = read(file);
      expect(text).toContain(SNIPPET);
      expect(text).toContain("id-token: write");
    });
  }

  it("the workflow in action/README.md is valid YAML with push to the default branch and id-token: write", () => {
    const text = read("action/README.md");
    const block = /```yaml\n([\s\S]*?)```/.exec(text.slice(text.indexOf("## README badge")))?.[1];
    expect(block, "no yaml block under ## README badge").toBeDefined();
    const doc = parse(block as string);
    expect(doc.on.push.branches).toEqual(["main"]);
    expect(doc.permissions["id-token"]).toBe("write");
    expect(JSON.stringify(doc.jobs)).toContain("Fortunian/tocsin/action@v1");
  });
});
