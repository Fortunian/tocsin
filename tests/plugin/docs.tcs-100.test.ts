// README, docs/API.md and docs/OPERATING.md tell a user how to install the
// Claude Code plugin and an operator how to submit it to the directory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_INSTALL_COMMAND } from "../../packages/cli/src/connect.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const CMD = "claude plugin install tocsin --marketplace Fortunian/tocsin";

describe("plugin docs", () => {
  it("the CLI hint and the docs use the same command", () => {
    expect(PLUGIN_INSTALL_COMMAND).toBe(CMD);
  });

  it("README.md and docs/API.md give the install command", () => {
    expect(read("README.md")).toContain(CMD);
    const api = read("docs/API.md");
    expect(api).toContain(CMD);
    expect(api).toMatch(/^### Claude Code plugin$/m);
  });

  it("the /docs page carries the plugin section", () => {
    const gen = read("site/docs.generated.ts");
    expect(gen).toContain("Claude Code plugin");
    expect(gen).toContain(CMD);
  });

  it("docs/OPERATING.md has the directory submission steps", () => {
    const op = read("docs/OPERATING.md");
    expect(op).toMatch(/^## Claude Code plugin directory$/m);
    expect(op).toContain("claude.ai/directory/manage");
    expect(op).toContain("paid plan");
    expect(op).toContain("bash scripts/validate-plugin.sh");
  });
});
