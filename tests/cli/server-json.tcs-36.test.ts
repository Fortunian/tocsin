// mcp/server.json (the MCP registry manifest) and the workflow that publishes it.
// Runs in Node: ajv compiles with new Function, which workerd blocks.
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_MCP_URL } from "../../packages/cli/src/mcp-config.js";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");

const schema = JSON.parse(read("tests/fixtures/mcp-registry/server.schema.2025-12-11.subset.json"));
const server = JSON.parse(read("mcp/server.json"));

function validator() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addFormat("uri", (s: string) => URL.canParse(s));
  return ajv.compile(schema);
}

// The custom domain of the MCP worker: routes = [{ pattern = "…", custom_domain = true }].
function mcpWorkerDomain(): string {
  const toml = read("workers/mcp/wrangler.toml");
  const routes = /^routes\s*=\s*\[(.*)\]\s*$/m.exec(toml);
  if (!routes) throw new Error("workers/mcp/wrangler.toml has no routes line");
  const entry = /\{\s*pattern\s*=\s*"([^"]+)"\s*,\s*custom_domain\s*=\s*true\s*\}/.exec(routes[1]);
  if (!entry) throw new Error(`no custom_domain route in: ${routes[1]}`);
  return entry[1];
}

describe("mcp/server.json", () => {
  it("validates against the registry schema fixture and names it", () => {
    const validate = validator();
    const ok = validate(server);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(server.$schema).toBe(schema.$id);
  });

  it("is sh.tocsin/tocsin with one streamable HTTP remote and no auth", () => {
    expect(server.name).toBe("sh.tocsin/tocsin");
    expect(server.remotes).toHaveLength(1);
    expect(server.remotes[0].type).toBe("streamable-http");
    expect(server.remotes[0]).not.toHaveProperty("headers");
    expect(server.remotes[0]).not.toHaveProperty("variables");
  });

  it("points at the MCP worker's custom domain, the same URL the CLI uses", () => {
    const domain = mcpWorkerDomain();
    expect(domain).toBe("mcp.tocsin.sh");
    expect(server.remotes[0].url).toBe(`https://${domain}/mcp`);
    expect(server.remotes[0].url).toBe(DEFAULT_MCP_URL);
  });

  it("the validator rejects a remote type the registry does not take", () => {
    const bad = structuredClone(server);
    bad.remotes[0].type = "http";
    expect(validator()(bad)).toBe(false);
    const badName = structuredClone(server);
    badName.name = "tocsin";
    expect(validator()(badName)).toBe(false);
  });

  it("version is the root package.json version (the version the MCP worker reports)", () => {
    expect(server.version).toBe(JSON.parse(read("package.json")).version);
  });
});

describe("publish-mcp-registry.yml", () => {
  const wf = parse(read(".github/workflows/publish-mcp-registry.yml"));
  const steps: { name?: string; run?: string; env?: Record<string, string> }[] = Object.values(wf.jobs as Record<string, { steps: [] }>).flatMap((j) => j.steps);
  const runs = steps.map((s) => s.run ?? "");
  const at = (needle: string) => runs.findIndex((r) => r.includes(needle));

  it("runs on manual dispatch only", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
  });

  it("validates, then logs in, then publishes", () => {
    const validate = at("mcp-publisher validate mcp/server.json");
    const login = at("mcp-publisher login dns --domain=tocsin.sh");
    const publish = at("mcp-publisher publish mcp/server.json");
    expect(validate).toBeGreaterThanOrEqual(0);
    expect(login).toBeGreaterThan(validate);
    expect(publish).toBeGreaterThan(login);
  });

  it("checks the key before login and passes it only through env", () => {
    const guard = steps.findIndex((s) => s.env?.MCP_REGISTRY_DNS_KEY !== undefined && !(s.run ?? "").includes("login"));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(at("mcp-publisher login"));
    expect(runs[guard]).toMatch(/exit 1/);
    for (const r of runs) expect(r).not.toContain("${{ secrets.");
  });

  it("downloads a pinned mcp-publisher release", () => {
    const download = runs.find((r) => r.includes("releases/download/"));
    expect(download).toBeDefined();
    expect(download).toMatch(/releases\/download\/v\d+\.\d+\.\d+\//);
    for (const r of runs) expect(r).not.toContain("latest/");
  });
});
