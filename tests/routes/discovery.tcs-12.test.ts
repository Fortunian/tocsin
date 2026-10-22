import { describe, expect, it } from "vitest";
import validateWellKnown from "../../src/schema/well-known.validate.generated.js";
import { get } from "./seed.tcs-3";

const ip = "192.0.2.124";
const MCP_URL = "https://mcp.tocsin.sh/mcp";

describe("MCP discovery (production entry src/index.ts)", () => {
  it("/.well-known/tocsin.json carries endpoints.mcp and stays schema-valid", async () => {
    const res = await get("/.well-known/tocsin.json", ip);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoints: Record<string, string>; mcp: string };
    expect(validateWellKnown(body), JSON.stringify(validateWellKnown.errors)).toBe(true);
    expect(body.endpoints.mcp).toBe(MCP_URL);
    expect(body.mcp).toBe("https://mcp.tocsin.sh");
  });

  it("/llms.txt has an MCP section with config for Claude Code, Cursor and Claude Desktop", async () => {
    const res = await get("/llms.txt", ip);
    expect(res.status).toBe(200);
    const text = await res.text();
    const mcp = text.slice(text.indexOf("## MCP"));
    expect(text).toContain("## MCP");
    expect(mcp).toContain(`claude mcp add --transport http tocsin ${MCP_URL}`);
    expect(mcp).toContain(`{"mcpServers":{"tocsin":{"url":"${MCP_URL}"}}}`);
    expect(mcp).toContain(`{"mcpServers":{"tocsin":{"command":"npx","args":["-y","mcp-remote","${MCP_URL}"]}}}`);
    for (const tool of ["tocsin_latest", "tocsin_check", "tocsin_get", "tocsin_watchlist_events"]) {
      expect(mcp).toContain(tool);
    }
    expect(mcp).toContain("Authorization: Bearer");
    expect(text).toContain("order=desc");
  });
});
