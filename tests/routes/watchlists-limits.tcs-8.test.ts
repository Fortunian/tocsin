import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, newKey, nextIp } from "./keys-helpers.tcs-8";

// Round 2 of TCS-8 review: per-key rate limit, filter input caps, a bounded
// list read and a body cap on POST /v1/keys. The rate window is one clock
// minute, so the clock is pinned: a burst never crosses a boundary.
const PINNED = Date.UTC(2026, 9, 22, 2, 0, 15); // 15 s into a minute window
const WINDOW = Math.floor(PINNED / 60_000);

async function setKeyRate(value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('watchlists.key_rate_per_minute', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(value)
    .run();
}

async function burst(key: string, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await call("GET", "/v1/watchlists", { key })).status);
  return out;
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe("per-key rate limit on the watch list routes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await setKeyRate("120");
  });

  it("seeds watchlists.key_rate_per_minute = 120", async () => {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'watchlists.key_rate_per_minute'").first<{ value: string }>();
    expect(row?.value).toBe("120");
  });

  it("answers 429 with Retry-After on the 121st call in a minute for one key; another key is unaffected", async () => {
    const a = await newKey();
    const b = await newKey();
    const ok = await burst(a.key, 120);
    expect(ok.every((s) => s === 200)).toBe(true);
    expect(await env.CURSORS.get(`rl:v1:key:${a.key_id}:${WINDOW}`)).toBe("120");

    // Every authenticated route shares the key's budget, from any IP.
    for (const [method, path] of [
      ["GET", "/v1/watchlists"],
      ["POST", "/v1/watchlists"],
      ["DELETE", "/v1/watchlists/wl_x"],
      ["GET", "/v1/watchlists/wl_x/events"],
    ] as const) {
      const res = await call(method, path, { key: a.key, body: method === "POST" ? { name: "n" } : undefined, ip: nextIp() });
      expect(res.status, `${method} ${path}`).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("45");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await call("GET", "/v1/watchlists", { key: b.key })).status).toBe(200);

    vi.setSystemTime(PINNED + 60_000);
    expect((await call("GET", "/v1/watchlists", { key: a.key })).status).toBe(200);
  });

  it("takes the limit from the settings row", async () => {
    await setKeyRate("3");
    const { key } = await newKey();
    expect(await burst(key, 4)).toEqual([200, 200, 200, 429]);
  });

  it("an unknown key is 401, not counted against any key", async () => {
    const res = await call("GET", "/v1/watchlists", { key: "tcs_" + "0".repeat(64) });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/watchlists input caps", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["name over 100", { name: "n".repeat(101) }, /name/],
    ["ecosystem over 200", { name: "x", ecosystems: ["e".repeat(201)] }, /ecosystems/],
    ["unknown ecosystem", { name: "x", ecosystems: ["npm", "Maven"] }, /ecosystems.*Maven/],
    ["21 ecosystems", { name: "x", ecosystems: Array.from({ length: 21 }, (_, i) => `eco-${i}`) }, /ecosystems/],
    ["component over 200", { name: "x", components: ["c".repeat(201)] }, /components/],
    ["11 runtimes", { name: "x", runtimes: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`rt${i}`, "1.0.0"])) }, /runtimes/],
    ["runtime version over 200", { name: "x", runtimes: { node: "1".repeat(201) } }, /runtimes/],
    ["runtime name over 200", { name: "x", runtimes: { ["r".repeat(201)]: "1.0.0" } }, /runtimes/],
    ["filter over 64 KB", { name: "x", components: Array.from({ length: 1000 }, (_, i) => `${"p".repeat(70)}-${i}`) }, /filter/],
  ];
  for (const [label, body, field] of cases) {
    it(`answers 400 naming the field: ${label}`, async () => {
      const { key } = await newKey();
      const res = await call("POST", "/v1/watchlists", { key, body });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatch(field);
    });
  }

  it("accepts the caps exactly: name 100, strings 200, 10 runtimes, every known ecosystem", async () => {
    const { key } = await newKey();
    const ecosystems = ["npm", "PyPI", "Go", "Packagist", "crates.io", "RubyGems", "node", "php", "python", "go", "deno", "bun"];
    const runtimes = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`rt${i}`, "1".repeat(200)]));
    const res = await call("POST", "/v1/watchlists", {
      key,
      body: { name: "n".repeat(100), ecosystems, components: ["c".repeat(200)], runtimes },
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

describe("GET /v1/watchlists is bounded", () => {
  it("answers at most plans.max_watchlists lists, even with more rows stored", async () => {
    const { key, key_id } = await newKey();
    const insert = env.DB.prepare(
      "INSERT INTO watchlists (id, key_id, name, filter_json, cursor, delivery, created_at) VALUES (?, ?, ?, '{}', 0, 'poll', ?)",
    );
    await env.DB.batch(
      Array.from({ length: 30 }, (_, i) => insert.bind(`wl_bound_${i}`, key_id, `l${i}`, `2026-10-22T00:00:${String(i).padStart(2, "0")}.000Z`)),
    );
    const res = await call("GET", "/v1/watchlists", { key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { watchlists: { id: string }[] };
    expect(body.watchlists).toHaveLength(25);
    expect(body.watchlists[0].id).toBe("wl_bound_0");
  });
});

describe("POST /v1/keys body cap", () => {
  it("answers 413 for a body over keys.max_body_bytes (4096)", async () => {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'keys.max_body_bytes'").first<{ value: string }>();
    expect(row?.value).toBe("4096");
    const res = await call("POST", "/v1/keys", { rawBody: JSON.stringify({ email: "a@example.test", pad: "x".repeat(5000) }) });
    expect(res.status).toBe(413);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
