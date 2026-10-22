import { describe, expect, it } from "vitest";
import type { Advisory } from "../../src/schema/advisory";
import { get, idFor, seed, type SeedRow } from "./seed.tcs-3";

// order=desc on /v1/events, through the production entry (src/index.ts). Each
// test seeds its own ids, cursor band and ecosystem tag, and sends its own IP.

interface Page {
  events: Advisory[];
  next_cursor: number;
  has_more: boolean;
}

function rows(prefix: string, n: number, cursorBase: number, ecosystem: string): SeedRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: idFor(prefix, i), cursor: cursorBase + i, ecosystem }));
}

async function page(path: string, ip: string): Promise<{ body: Page; etag: string | null }> {
  const res = await get(path, ip);
  expect(res.status).toBe(200);
  return { body: (await res.json()) as Page, etag: res.headers.get("etag") };
}

describe("GET /v1/events?order=desc", () => {
  it("answers the newest rows first; next_cursor is the newest cursor on the page", async () => {
    const ip = "192.0.2.120";
    await seed(rows("DSA", 5, 120_001, "eco-desc-a"));

    const p = (await page("/v1/events?ecosystem=eco-desc-a&order=desc&limit=2", ip)).body;
    expect(p.events.map((e) => e.id)).toEqual([idFor("DSA", 4), idFor("DSA", 3)]);
    expect(p.has_more).toBe(true);
    expect(p.next_cursor).toBe(120_005);

    // since bounds from below: only rows with cursor > since, newest first.
    const s = (await page("/v1/events?ecosystem=eco-desc-a&order=desc&since=120003", ip)).body;
    expect(s.events.map((e) => e.id)).toEqual([idFor("DSA", 4), idFor("DSA", 3)]);
    expect(s.has_more).toBe(false);
    expect(s.next_cursor).toBe(120_005);

    // The last page of older rows says has_more=false.
    const all = (await page("/v1/events?ecosystem=eco-desc-a&order=desc&limit=5", ip)).body;
    expect(all.events.map((e) => e.id)).toEqual([4, 3, 2, 1, 0].map((i) => idFor("DSA", i)));
    expect(all.has_more).toBe(false);
  });

  it("an empty desc page returns since as next_cursor", async () => {
    const p = (await page("/v1/events?ecosystem=eco-desc-empty&order=desc&since=42", "192.0.2.121")).body;
    expect(p.events).toEqual([]);
    expect(p.has_more).toBe(false);
    expect(p.next_cursor).toBe(42);
  });

  it("rejects any order other than asc or desc", async () => {
    for (const bad of ["bad", "DESC", ""]) {
      const res = await get(`/v1/events?order=${bad}`, "192.0.2.122");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("order");
    }
  });

  it("leaves asc unchanged: order=asc equals no order, and desc has its own ETag", async () => {
    const ip = "192.0.2.123";
    await seed(rows("DSB", 3, 130_001, "eco-desc-b"));
    const plain = await page("/v1/events?ecosystem=eco-desc-b&since=0", ip);
    const asc = await page("/v1/events?ecosystem=eco-desc-b&since=0&order=asc", ip);
    const desc = await page("/v1/events?ecosystem=eco-desc-b&since=0&order=desc", ip);
    expect(asc.body).toEqual(plain.body);
    expect(asc.etag).toBe(plain.etag);
    expect(plain.body.events.map((e) => e.id)).toEqual([0, 1, 2].map((i) => idFor("DSB", i)));
    expect(desc.body.events.map((e) => e.id)).toEqual([2, 1, 0].map((i) => idFor("DSB", i)));
    // Same last cursor, same has_more, same filters: only order tells them apart.
    expect(desc.body.next_cursor).toBe(plain.body.next_cursor);
    expect(desc.etag).not.toBe(plain.etag);
  });
});
