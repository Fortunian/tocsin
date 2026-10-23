// The "Add to Cursor" and "Add to VS Code" links on / and /docs, through the
// production entry (src/index.ts -> app).
import { describe, expect, it } from "vitest";
import { mcpServerConfig } from "../../packages/cli/src/mcp-config";
import { get } from "./seed.tcs-3";

const ip = "198.51.100.36";
const CONFIG = { type: "http", url: "https://mcp.tocsin.sh/mcp" };

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The href and position of the <a> whose text is `label`. Fails when absent.
function link(html: string, label: string): { href: string; at: number } {
  const m = new RegExp(`<a\\b[^>]*\\bhref="([^"]*)"[^>]*>${label}</a>`).exec(html);
  if (!m) throw new Error(`no <a> with text "${label}"`);
  return { href: unescape(m[1]), at: m.index };
}

function cursorConfig(href: string): unknown {
  const q = href.indexOf("?");
  expect(href.slice(0, q)).toBe("cursor://anysphere.cursor-deeplink/mcp/install");
  const params = new URLSearchParams(href.slice(q + 1));
  expect(params.get("name")).toBe("tocsin");
  return JSON.parse(atob(params.get("config") ?? ""));
}

function vscodeConfig(href: string): unknown {
  const prefix = "vscode:mcp/install?";
  expect(href.startsWith(prefix)).toBe(true);
  const { name, ...config } = JSON.parse(decodeURIComponent(href.slice(prefix.length)));
  expect(name).toBe("tocsin");
  return config;
}

async function html(path: string): Promise<string> {
  const res = await get(path, ip);
  expect(res.status).toBe(200);
  return res.text();
}

describe("install links", () => {
  it("/ shows both links after npx tocsin connect, decoding to the connect config", async () => {
    const page = await html("/");
    const connect = page.indexOf('data-copy="npx tocsin connect"');
    const wires = page.indexOf("Wires Claude Code");
    expect(connect).toBeGreaterThan(0);
    const cursor = link(page, "Add to Cursor");
    const vscode = link(page, "Add to VS Code");
    for (const l of [cursor, vscode]) {
      expect(l.at).toBeGreaterThan(connect);
      expect(l.at).toBeLessThan(wires);
    }
    expect(cursorConfig(cursor.href)).toEqual(CONFIG);
    expect(vscodeConfig(vscode.href)).toEqual(CONFIG);
  });

  it("/docs shows both links after the connect command block", async () => {
    const page = await html("/docs");
    const block = page.indexOf("<pre><code>npx tocsin connect</code></pre>");
    expect(block).toBeGreaterThan(0);
    const cursor = link(page, "Add to Cursor");
    const vscode = link(page, "Add to VS Code");
    expect(cursor.at).toBeGreaterThan(block);
    expect(vscode.at).toBeGreaterThan(block);
    expect(cursorConfig(cursor.href)).toEqual(CONFIG);
    expect(vscodeConfig(vscode.href)).toEqual(CONFIG);
  });

  it("the landing links decode to the shared config object", async () => {
    const page = await html("/");
    expect(cursorConfig(link(page, "Add to Cursor").href)).toEqual(mcpServerConfig());
    expect(vscodeConfig(link(page, "Add to VS Code").href)).toEqual(mcpServerConfig());
  });
});
