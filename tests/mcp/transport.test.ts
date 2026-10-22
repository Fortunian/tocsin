import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBearer } from "../../workers/mcp/src/index";

// Every request goes through the MCP worker's production entry
// (workers/mcp/src/index.ts, the `main` of workers/mcp/wrangler.toml). The
// Durable Object runs in this isolate, so a spy on fetch fakes the Tocsin API
// at TOCSIN_BASE_URL (set for this project in vitest.config.ts). 0 real calls.

const API = "https://api-fixture.tocsin.test";
const worker = exports.default;

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function readRpc(res: Response, id: number): Promise<RpcResponse> {
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("application/json")) return (await res.json()) as RpcResponse;
  // text/event-stream: read until the data line that carries our id.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const msg = JSON.parse(line.slice(5)) as RpcResponse;
      if (msg.id === id) {
        await reader.cancel();
        return msg;
      }
    }
    if (done) throw new Error(`no JSON-RPC response with id ${id} in: ${buf}`);
  }
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(
    new Request("https://mcp.tocsin.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vitest-fixture", version: "0.0.0" } },
};

async function session(headers: Record<string, string> = {}): Promise<{ sid: string; init: RpcResponse }> {
  const res = await post(INIT, headers);
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  const init = await readRpc(res, 1);
  const ack = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid!, ...headers });
  expect(ack.status).toBe(202);
  return { sid: sid!, init };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /mcp (streamable HTTP)", () => {
  it("initialize returns server info naming tocsin, with no auth header (no OAuth gate)", async () => {
    const { init } = await session();
    expect(init.error).toBeUndefined();
    const info = init.result!.serverInfo as { name: string; version: string };
    expect(info.name).toBe("tocsin");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("tools/list lists exactly the four tools", async () => {
    const { sid } = await session();
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid });
    expect(res.status).toBe(200);
    const msg = await readRpc(res, 2);
    const names = (msg.result!.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["tocsin_check", "tocsin_get", "tocsin_latest", "tocsin_watchlist_events"]);
  });

  it("tools/call tocsin_get answers {human,data} as text and structuredContent", async () => {
    const fixtureDoc = { id: "tcs_01JA0000000000000000000000", cve_ids: ["CVE-2026-111497"], component: "node", severity: { score: 8.1, label: "high" }, exploited: false, action: "Upgrade node to 24.22.1 or later." };
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === API && url.pathname === "/v1/events/cve/CVE-2026-111497") return Response.json(fixtureDoc);
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const { sid } = await session();
    const res = await post(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tocsin_get", arguments: { id_or_cve: "CVE-2026-111497" } } },
      { "mcp-session-id": sid },
    );
    const msg = await readRpc(res, 3);
    const result = msg.result as { content: { type: string; text: string }[]; structuredContent: { human: string; data: { id: string } }; isError?: boolean };
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent.data.id).toBe(fixtureDoc.id);
    expect(result.structuredContent.human).toBe("tcs_01JA0000000000000000000000 (CVE-2026-111497) node high: Upgrade node to 24.22.1 or later.");
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("bearer: the Authorization header on the MCP connection reaches tocsin_watchlist_events", async () => {
    const seen: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.origin === API && url.pathname === "/v1/watchlists/wl_1/events") {
        seen.push(req.headers.get("authorization"));
        return Response.json({ events: [], next_cursor: 0, has_more: false });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const auth = { Authorization: "Bearer tcs_fixture_x" };
    const { sid } = await session(auth);
    const res = await post(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tocsin_watchlist_events", arguments: { watchlist_id: "wl_1" } } },
      { "mcp-session-id": sid, ...auth },
    );
    const msg = await readRpc(res, 4);
    const result = msg.result as { structuredContent: { human: string }; isError?: boolean };
    expect(seen).toEqual(["Bearer tcs_fixture_x"]);
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent.human).toBe("No new events on watch list wl_1.");
  });

  it("bearer: without an Authorization header the tool answers isError and calls nothing", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const { sid } = await session();
    const res = await post(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "tocsin_watchlist_events", arguments: { watchlist_id: "wl_1" } } },
      { "mcp-session-id": sid },
    );
    const msg = await readRpc(res, 5);
    expect((msg.result as { isError?: boolean }).isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range limit as an input error, not a clamp", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const { sid } = await session();
    const res = await post(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "tocsin_latest", arguments: { limit: 500 } } },
      { "mcp-session-id": sid },
    );
    const msg = await readRpc(res, 6);
    const failed = msg.error !== undefined || (msg.result as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers GET / with a pointer and an unknown path with 404", async () => {
    const root = await worker.fetch(new Request("https://mcp.tocsin.test/"));
    expect(root.status).toBe(200);
    expect(((await root.json()) as { mcp: string }).mcp).toBe("/mcp");
    const other = await worker.fetch(new Request("https://mcp.tocsin.test/nope"));
    expect(other.status).toBe(404);
  });
});

describe("parseBearer", () => {
  it.each([
    ["Bearer tcs_fixture_x", "tcs_fixture_x"],
    ["bearer tcs_fixture_x", "tcs_fixture_x"],
    ["  Bearer   tcs_fixture_x  ", "tcs_fixture_x"],
    ["Bearer ", null],
    ["Bearer", null],
    ["Basic fixture-abc", null],
    ["", null],
    [null, null],
  ])("%j → %j", (header, want) => {
    expect(parseBearer(header)).toBe(want);
  });
});
