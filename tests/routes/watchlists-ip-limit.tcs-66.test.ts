import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { clearLimitMemo } from "../../src/middleware/ratelimit";
import { call, newKey, nextIp, uniqueEmail } from "./keys-helpers.tcs-8";

// TCS-66: a per-IP limit (settings.watchlists.ip_rate_per_minute, 300 seeded)
// runs before requireApiKey on /v1/watchlists/* and before the keys limiter on
// /v1/keys. The window is one clock minute, so the clock is pinned. The limit
// is memoized per isolate for settings.watchlists.ip_rate_cache_seconds (60
// seeded); a test that edits the row clears the memo, like a TTL expiry.
const PINNED = Date.UTC(2026, 9, 23, 4, 0, 15); // 15 s into a minute window
const WINDOW = Math.floor(PINNED / 60_000);
const UNKNOWN_KEY = "tcs_" + "0".repeat(64);
const SETTINGS_SQL = "SELECT value FROM settings WHERE key = ?";

let ipSeq = 0;
function ip(): string {
  ipSeq += 1;
  return `2001:db8:66::${ipSeq.toString(16)}`;
}

async function setRow(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
    return;
  }
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

const setIpRate = (v: string | null) => setRow("watchlists.ip_rate_per_minute", v);
const setMemoSeconds = (v: string | null) => setRow("watchlists.ip_rate_cache_seconds", v);
const authCounter = (addr: string) => `rl:v1:auth:${addr}:${WINDOW}`;

// A D1 binding that records the SQL of every statement it prepares.
function countingDb(): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const real = env.DB;
  const db = {
    prepare(q: string) {
      sql.push(q);
      return real.prepare(q);
    },
    batch(stmts: D1PreparedStatement[]) {
      sql.push("<batch>");
      return real.batch(stmts);
    },
    exec(q: string) {
      sql.push(q);
      return real.exec(q);
    },
    dump() {
      return real.dump();
    },
    withSession(...args: Parameters<D1Database["withSession"]>) {
      return real.withSession(...args);
    },
  } as unknown as D1Database;
  return { db, sql };
}

// Drives the production worker (src/index.ts) with the counting D1 binding.
async function counted(method: string, path: string, addr: string, key?: string, body?: unknown): Promise<{ res: Response; sql: string[] }> {
  const { db, sql } = countingDb();
  const headers: Record<string, string> = { "CF-Connecting-IP": addr };
  if (key !== undefined) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://tocsin.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    { ...env, DB: db },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, sql };
}

const touchesAuth = (sql: string[]) => sql.some((q) => /api_keys|plans/.test(q));

describe("per-IP limit before API-key auth", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED);
    clearLimitMemo();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await setIpRate("300");
    await setMemoSeconds("60");
    await setRow("watchlists.key_rate_per_minute", "120");
    clearLimitMemo();
  });

  it("seeds watchlists.ip_rate_per_minute = 300 and watchlists.ip_rate_cache_seconds = 60", async () => {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'watchlists.ip_rate_per_minute'").first<{ value: string }>();
    expect(row?.value).toBe("300");
    const memo = await env.DB.prepare("SELECT value FROM settings WHERE key = 'watchlists.ip_rate_cache_seconds'").first<{ value: string }>();
    expect(memo?.value).toBe("60");
  });

  it("answers 429 on the 301st unknown-key request from one IP, with no auth statement", async () => {
    const x = ip();
    for (let i = 0; i < 300; i++) {
      const res = await call("GET", "/v1/watchlists", { key: UNKNOWN_KEY, ip: x });
      expect(res.status, `request ${i + 1}`).toBe(401);
    }
    expect(await env.CURSORS.get(authCounter(x))).toBe("300");

    const { res, sql } = await counted("GET", "/v1/watchlists", x, UNKNOWN_KEY);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
    // The limit is memoized in this isolate: no D1 statement at all.
    expect(sql).toEqual([]);

    // The same request from an unblocked IP does reach auth.
    const open = await counted("GET", "/v1/watchlists", ip(), UNKNOWN_KEY);
    expect(open.res.status).toBe(401);
    expect(touchesAuth(open.sql)).toBe(true);
  }, 60_000);

  it("a valid key from another IP is unaffected; the same key from the blocked IP is 429", async () => {
    const x = ip();
    await env.CURSORS.put(authCounter(x), "300");
    const { key } = await newKey(uniqueEmail("ip66"));
    expect((await call("GET", "/v1/watchlists", { key, ip: ip() })).status).toBe(200);
    expect((await call("GET", "/v1/watchlists", { key, ip: x })).status).toBe(429);
  });

  it("gates every watch list path and POST /v1/keys before auth, and leaves other routes alone", async () => {
    const z = ip();
    await env.CURSORS.put(authCounter(z), "300");
    for (const [method, path, body] of [
      ["GET", "/v1/watchlists", undefined],
      ["POST", "/v1/watchlists", { name: "n" }],
      ["GET", "/v1/watchlists/wl_x/events", undefined],
      ["DELETE", "/v1/watchlists/wl_x", undefined],
      ["POST", "/v1/keys", { email: uniqueEmail("ip66") }],
    ] as const) {
      const { res, sql } = await counted(method, path, z, path.startsWith("/v1/keys") ? undefined : UNKNOWN_KEY, body);
      expect(res.status, `${method} ${path}`).toBe(429);
      expect(res.headers.get("Retry-After"), `${method} ${path}`).toBe("45");
      expect(touchesAuth(sql), `${method} ${path}`).toBe(false);
    }
    expect((await call("GET", "/v1/events?ecosystem=eco-ip66", { ip: z })).status).not.toBe(429);
    expect((await call("GET", "/v1/check", { ip: z })).status).not.toBe(429);
    expect(await env.CURSORS.get(authCounter(z))).toBe("300");
  });

  it("takes the limit from the settings row, with fallback 300", async () => {
    await setIpRate("2");
    const a = ip();
    const got: number[] = [];
    for (let i = 0; i < 3; i++) got.push((await call("GET", "/v1/watchlists", { key: UNKNOWN_KEY, ip: a })).status);
    expect(got).toEqual([401, 401, 429]);

    for (const value of [null, "abc"]) {
      await setIpRate(value);
      clearLimitMemo();
      const b = ip();
      await env.CURSORS.put(authCounter(b), "299");
      expect((await call("GET", "/v1/watchlists", { key: UNKNOWN_KEY, ip: b })).status, `row ${value}`).toBe(401);
      expect((await call("GET", "/v1/watchlists", { key: UNKNOWN_KEY, ip: b })).status, `row ${value}`).toBe(429);
    }
  });

  it("reads the limit once per memo window, and reads it every time when the window row is 0", async () => {
    const x = ip();
    await env.CURSORS.put(authCounter(x), "300");
    // Cold isolate: one read of each row, then 429.
    const cold = await counted("GET", "/v1/watchlists", x, UNKNOWN_KEY);
    expect(cold.res.status).toBe(429);
    expect(cold.sql).toEqual([SETTINGS_SQL, SETTINGS_SQL]);
    expect(touchesAuth(cold.sql)).toBe(false);
    // Warm: no read, and an edit to the row waits for the window to end.
    await setIpRate("1000");
    const warm = await counted("GET", "/v1/watchlists", x, UNKNOWN_KEY);
    expect(warm.res.status).toBe(429);
    expect(warm.sql).toEqual([]);
    // 61 s later (next minute window, so a fresh counter) the new row applies.
    vi.setSystemTime(PINNED + 61_000);
    const y = ip();
    await env.CURSORS.put(`rl:v1:auth:${y}:${WINDOW + 1}`, "999");
    const after = await counted("GET", "/v1/watchlists", y, UNKNOWN_KEY);
    expect(after.res.status).toBe(401);
    expect(after.sql.slice(0, 2)).toEqual([SETTINGS_SQL, SETTINGS_SQL]);

    // Window row 0: no memo, the limit row is read on every request.
    await setMemoSeconds("0");
    clearLimitMemo();
    await setIpRate("300");
    const z = ip();
    await env.CURSORS.put(`rl:v1:auth:${z}:${WINDOW + 1}`, "300");
    for (let i = 0; i < 2; i++) {
      const r = await counted("GET", "/v1/watchlists", z, UNKNOWN_KEY);
      expect(r.res.status).toBe(429);
      expect(r.sql).toEqual([SETTINGS_SQL, SETTINGS_SQL]);
    }
  });

  it("keeps the per-key limit as the second gate", async () => {
    const { key } = await newKey(uniqueEmail("ip66"));
    await setRow("watchlists.key_rate_per_minute", "1");
    const first = nextIp();
    const second = nextIp();
    expect((await call("GET", "/v1/watchlists", { key, ip: first })).status).toBe(200);
    const refused = await call("GET", "/v1/watchlists", { key, ip: second });
    expect(refused.status).toBe(429);
    // The IP gate passed and counted; the key gate refused.
    expect(await env.CURSORS.get(authCounter(first))).toBe("1");
    expect(await env.CURSORS.get(authCounter(second))).toBe("1");
  });

  it("runs before the keys limiter on POST /v1/keys", async () => {
    const k = ip();
    await env.CURSORS.put(authCounter(k), "300");
    const res = await call("POST", "/v1/keys", { ip: k, body: { email: uniqueEmail("ip66") } });
    expect(res.status).toBe(429);
    expect(await env.CURSORS.get(`rl:v1:keys:${k}:${WINDOW}`)).toBeNull();

    // An open IP passes the IP gate and is counted by both limiters.
    const open = ip();
    expect((await call("POST", "/v1/keys", { ip: open, body: { email: uniqueEmail("ip66") } })).status).toBe(202);
    expect(await env.CURSORS.get(authCounter(open))).toBe("1");
    expect(await env.CURSORS.get(`rl:v1:keys:${open}:${WINDOW}`)).toBe("1");
  });
});
