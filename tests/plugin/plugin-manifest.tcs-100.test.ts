// The Claude Code plugin (plugins/tocsin) and the in-repo marketplace
// (.claude-plugin/marketplace.json): names match, paths are relative, the MCP
// server and the hook equal the ones `tocsin connect` writes, and the version
// equals the CLI package version. This check runs on every runner, with or
// without the claude CLI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { HOOK_COMMAND } from "../../packages/cli/src/connect.js";
import { DEFAULT_MCP_URL, mcpServerConfig } from "../../packages/cli/src/mcp-config.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const PLUGIN = "plugins/tocsin/.claude-plugin/plugin.json";
const MARKET = ".claude-plugin/marketplace.json";

const MARKET_SCHEMA = {
  type: "object",
  required: ["name", "owner", "plugins"],
  properties: {
    name: { type: "string", minLength: 1 },
    owner: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 } } },
    plugins: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "source"],
        properties: { name: { type: "string", minLength: 1 }, source: { type: "string", minLength: 1 } },
      },
    },
  },
};

describe("plugin manifest", () => {
  it("plugin.json: name, displayName, description, author, homepage, repository, license", () => {
    const p = readJson(PLUGIN);
    expect(p.name).toBe("tocsin");
    expect(p.displayName).toBe("Tocsin");
    expect(typeof p.description).toBe("string");
    expect(p.description.length).toBeGreaterThan(0);
    expect(p.author?.name).toBeTruthy();
    expect(p.homepage).toBe("https://tocsin.sh");
    expect(String(p.repository)).toContain("Fortunian/tocsin");
    expect(p.license).toBe("Apache-2.0");
  });

  it("plugin.json version equals the CLI package version", () => {
    expect(readJson(PLUGIN).version).toBe(readJson("packages/cli/package.json").version);
  });

  it("every path-valued component key in plugin.json starts with ./", () => {
    const p = readJson(PLUGIN);
    for (const k of ["commands", "agents", "skills", "hooks", "mcpServers", "outputStyles", "lspServers"]) {
      const v = p[k];
      for (const s of [v].flat()) if (typeof s === "string") expect(s.startsWith("./"), `${k}: ${s}`).toBe(true);
    }
  });

  it("marketplace.json: name tocsin, owner Fortunian, one plugin with the same name and a ./ source", () => {
    const m = readJson(MARKET);
    expect(m.name).toBe("tocsin");
    expect(m.owner.name).toBe("Fortunian");
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0].name).toBe(readJson(PLUGIN).name);
    expect(m.plugins[0].source).toBe("./plugins/tocsin");
    for (const pl of m.plugins) if (typeof pl.source === "string") expect(pl.source.startsWith("./")).toBe(true);
  });

  it("marketplace.json passes the JSON schema check", () => {
    const validate = new Ajv({ allErrors: true }).compile(MARKET_SCHEMA);
    const ok = validate(readJson(MARKET));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(validate({ name: "tocsin", owner: {}, plugins: [] })).toBe(false);
  });

  it(".mcp.json: the tocsin server equals mcpServerConfig(), streamable HTTP, no auth", () => {
    const tocsin = readJson("plugins/tocsin/.mcp.json").mcpServers.tocsin;
    expect(tocsin).toEqual(mcpServerConfig());
    expect(tocsin.type).toBe("http");
    expect(tocsin.url).toBe(DEFAULT_MCP_URL);
    expect(tocsin.url).toBe("https://mcp.tocsin.sh/mcp");
    expect(tocsin).not.toHaveProperty("headers");
  });

  it("hooks.json: the SessionStart hook is the one `connect --hook` writes", () => {
    const h = readJson("plugins/tocsin/hooks/hooks.json");
    expect(h.hooks.SessionStart).toHaveLength(1);
    expect(h.hooks.SessionStart[0]).toEqual({ matcher: "startup", hooks: [{ type: "command", command: HOOK_COMMAND }] });
  });
});
