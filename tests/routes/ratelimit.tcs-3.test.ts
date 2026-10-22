import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "./seed.tcs-3";

// The limit comes from settings.feed.anon_rate_per_minute (60 seeded). Each
// test uses its own client IP, so counters never couple. The window is one
// clock minute, so the clock is pinned: a burst never crosses a boundary.
const PINNED = Date.UTC(2026, 9, 22, 1, 0, 15); // 15 s into a minute window

async function burst(ip: string, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await get("/v1/events?ecosystem=eco-rl", ip)).status);
  return statuses;
}

async function setLimit(value: string | null): Promise<void> {
  if (value === null) {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'feed.anon_rate_per_minute'").run();
  } else {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('feed.anon_rate_per_minute', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(value)
      .run();
  }
}

describe("rate limit on /v1/events", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses the 61st request in a minute from one IP with 429 + Retry-After", async () => {
    await setLimit("60");
    const a = "203.0.113.30";
    const statuses = await burst(a, 60);
    expect(statuses.every((s) => s === 200)).toBe(true);

    const refused = await get("/v1/events?ecosystem=eco-rl", a);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(typeof ((await refused.json()) as { error: unknown }).error).toBe("string");
    const retry = Number(refused.headers.get("retry-after"));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBe(45);

    // A refused IP does not affect another IP, and discovery is not limited.
    expect((await get("/v1/events?ecosystem=eco-rl", "203.0.113.31")).status).toBe(200);
    expect((await get("/llms.txt", a)).status).toBe(200);
    expect((await get("/.well-known/tocsin.json", a)).status).toBe(200);
    // The per-id routes share the limit.
    expect((await get("/v1/events/tcs_00000000000000000000000000", a)).status).toBe(429);

    // The next minute window starts a fresh count.
    vi.setSystemTime(PINNED + 60_000);
    expect((await get("/v1/events?ecosystem=eco-rl", a)).status).toBe(200);
  }, 30_000);

  it("reads the limit from the settings row", async () => {
    await setLimit("3");
    try {
      expect(await burst("203.0.113.32", 4)).toEqual([200, 200, 200, 429]);
    } finally {
      await setLimit("60");
    }
  });

  it("falls back to 60 when the settings row is missing", async () => {
    await setLimit(null);
    try {
      const statuses = await burst("203.0.113.33", 61);
      expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
      expect(statuses[60]).toBe(429);
    } finally {
      await setLimit("60");
    }
  }, 30_000);
});
