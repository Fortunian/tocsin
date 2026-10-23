// `tocsin connect --print` and the site's two install links come from one
// config object (packages/cli/src/mcp-config.ts), so they never drift.
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { mcpServerConfig } from "../../packages/cli/src/mcp-config.js";
import { cursorInstallUrl, vscodeInstallUrl } from "../../site/install.js";
import { fakeIo, type FakeIo } from "./helpers.tcs-13.js";

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

async function printed(): Promise<unknown> {
  io = await fakeIo(["connect", "--print"]);
  expect(io.env.TOCSIN_MCP_URL).toBeUndefined();
  expect(await main(io)).toBe(0);
  return JSON.parse(io.text().out).mcpServers.tocsin;
}

describe("connect --print and the install links", () => {
  it("--print prints the shared config", async () => {
    const block = await printed();
    expect(block).toEqual({ type: "http", url: "https://mcp.tocsin.sh/mcp" });
    expect(block).toEqual(mcpServerConfig());
  });

  it("the Cursor link decodes to the printed block", async () => {
    const block = await printed();
    const href = cursorInstallUrl();
    const q = href.indexOf("?");
    expect(href.slice(0, q)).toBe("cursor://anysphere.cursor-deeplink/mcp/install");
    // base64 + / = must be percent-encoded, or a query parser mangles them.
    // This config's base64 ends in "==", so the check is never vacuous.
    const raw = /[?&]config=([^&]*)/.exec(href)?.[1] ?? "";
    expect(raw).toMatch(/%3D%3D$/);
    expect(raw).not.toMatch(/[+/=]/);
    const params = new URLSearchParams(href.slice(q + 1));
    expect(params.get("name")).toBe("tocsin");
    expect(JSON.parse(atob(params.get("config") ?? ""))).toEqual(block);
  });

  it("the VS Code link decodes to the printed block plus the name", async () => {
    const block = await printed();
    const href = vscodeInstallUrl();
    expect(href.startsWith("vscode:mcp/install?")).toBe(true);
    const { name, ...config } = JSON.parse(decodeURIComponent(href.slice("vscode:mcp/install?".length)));
    expect(name).toBe("tocsin");
    expect(config).toEqual(block);
  });
});
