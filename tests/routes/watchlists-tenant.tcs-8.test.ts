import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, newKey, sha256HexOf } from "./keys-helpers.tcs-8";
import { idFor, seed } from "./seed.tcs-3";

describe("bearer auth on /v1/watchlists", () => {
  it("answers 401 with WWW-Authenticate for a missing, malformed or unknown key", async () => {
    const { key } = await newKey();
    const cases: (Record<string, string> | undefined)[] = [
      undefined,
      { Authorization: "Basic eDp5" },
      { Authorization: "Bearer" },
      { Authorization: "Bearer abc" },
      { Authorization: `Bearer ${key}x` },
      { Authorization: `Bearer ${await sha256HexOf(key)}` },
      { Authorization: `Bearer tcs_${await sha256HexOf(key)}` },
    ];
    for (const headers of cases) {
      const res = await call("GET", "/v1/watchlists", { headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
    for (const path of ["/v1/watchlists/wl_x/events"]) expect((await call("GET", path)).status).toBe(401);
    expect((await call("POST", "/v1/watchlists", { body: { name: "x" } })).status).toBe(401);
    expect((await call("DELETE", "/v1/watchlists/wl_x")).status).toBe(401);
  });

  it("accepts a valid key, with any case of the Bearer word", async () => {
    const { key } = await newKey();
    expect((await call("GET", "/v1/watchlists", { key })).status).toBe(200);
    expect((await call("GET", "/v1/watchlists", { headers: { Authorization: `bearer ${key}` } })).status).toBe(200);
  });

  it("answers 500 and no data when the key's plan row is missing (fails closed)", async () => {
    const { key, key_id } = await newKey();
    await env.DB.prepare("UPDATE api_keys SET plan = 'no-such-plan' WHERE id = ?").bind(key_id).run();
    const res = await call("GET", "/v1/watchlists", { key });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });

  it("moves last_used_at forward only when it is older than auth.last_used_resolution_seconds", async () => {
    const { key, key_id } = await newKey();
    const old = "2025-01-01T00:00:00.000Z";
    await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(old, key_id).run();
    expect((await call("GET", "/v1/watchlists", { key })).status).toBe(200);
    const read = async () => (await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").bind(key_id).first<{ last_used_at: string }>())!.last_used_at;
    const touched = await read();
    expect(touched > old).toBe(true);
    expect((await call("GET", "/v1/watchlists", { key })).status).toBe(200);
    expect(await read()).toBe(touched);
  });
});

describe("one key never reads or changes another key's watch lists", () => {
  it("key B gets 404 on A's list for events and delete, sees 0 of A's lists, and A's row and cursor stay", async () => {
    const a = await newKey();
    const b = await newKey();
    const res = await call("POST", "/v1/watchlists", { key: a.key, body: { name: "a-list", ecosystems: ["node"] } });
    expect(res.status).toBe(201);
    const list = (await res.json()) as { id: string; cursor: number };
    await seed([{ id: idFor("W8T", 0), cursor: list.cursor + 1, ecosystem: "node" }]);

    const ev = await call("GET", `/v1/watchlists/${list.id}/events`, { key: b.key });
    expect(ev.status).toBe(404);
    const del = await call("DELETE", `/v1/watchlists/${list.id}`, { key: b.key });
    expect(del.status).toBe(404);
    const listed = (await (await call("GET", "/v1/watchlists", { key: b.key })).json()) as { watchlists: unknown[] };
    expect(listed.watchlists).toEqual([]);

    const row = await env.DB.prepare("SELECT key_id, cursor FROM watchlists WHERE id = ?").bind(list.id).first<{ key_id: string; cursor: number }>();
    expect(row).toEqual({ key_id: a.key_id, cursor: list.cursor });

    // A still reads its own event.
    const own = await call("GET", `/v1/watchlists/${list.id}/events`, { key: a.key });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { events: { id: string }[] }).events.map((e) => e.id)).toEqual([idFor("W8T", 0)]);
  });
});
