import { describe, expect, it } from "vitest";
import type { Advisory } from "../../src/schema/advisory";
import { get, idFor, seed, type SeedRow } from "./seed.tcs-3";

// Every request goes through the production entry (src/index.ts). Each test
// seeds its own ids, its own cursor band and its own ecosystem/component tag,
// and sends its own client IP, so tests never share rows or rate-limit counters.

interface Page {
  events: Advisory[];
  next_cursor: number;
  has_more: boolean;
}

async function page(path: string, ip: string): Promise<Page> {
  const res = await get(path, ip);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  return (await res.json()) as Page;
}

function rows(prefix: string, n: number, cursorBase: number, extra: Partial<SeedRow> = {}): SeedRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: idFor(prefix, i), cursor: cursorBase + i, ...extra }));
}

describe("GET /v1/events", () => {
  it("pages 150 advisories by cursor: 100 with has_more, then the last 50", async () => {
    const ip = "203.0.113.10";
    await seed(rows("PGA", 150, 10_001, { ecosystem: "eco-page" }));

    const p1 = await page("/v1/events?ecosystem=eco-page&limit=100", ip);
    expect(p1.events).toHaveLength(100);
    expect(p1.has_more).toBe(true);
    expect(p1.next_cursor).toBe(10_100);

    const p2 = await page(`/v1/events?ecosystem=eco-page&since=${p1.next_cursor}&limit=100`, ip);
    expect(p2.events).toHaveLength(50);
    expect(p2.has_more).toBe(false);
    expect(p2.next_cursor).toBe(10_150);

    const ids = [...p1.events, ...p2.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(150);
    expect(ids).toEqual(rows("PGA", 150, 10_001).map((r) => r.id));
  });

  it("defaults to 50 and clamps limit=500 to 100", async () => {
    const ip = "203.0.113.11";
    await seed(rows("KMA", 120, 20_001, { ecosystem: "eco-limit" }));
    expect((await page("/v1/events?ecosystem=eco-limit", ip)).events).toHaveLength(50);
    const capped = await page("/v1/events?ecosystem=eco-limit&limit=500", ip);
    expect(capped.events).toHaveLength(100);
    expect(capped.has_more).toBe(true);
  });

  it("ecosystem=node returns only node; ecosystem=node,npm returns both", async () => {
    const ip = "203.0.113.12";
    const seeded = await seed([
      ...rows("ECN", 3, 30_001, { ecosystem: "node", component: "cmp-eco" }),
      ...rows("ECP", 3, 30_004, { ecosystem: "npm", component: "cmp-eco" }),
    ]);
    const nodeIds = seeded.filter((d) => d.ecosystem === "node").map((d) => d.id);
    const npmIds = seeded.filter((d) => d.ecosystem === "npm").map((d) => d.id);

    const onlyNode = await page("/v1/events?ecosystem=node&since=30000&limit=100", ip);
    expect(onlyNode.events.length).toBeGreaterThan(0);
    for (const e of onlyNode.events) expect(e.ecosystem).toBe("node");
    const got = onlyNode.events.map((e) => e.id);
    for (const id of nodeIds) expect(got).toContain(id);
    for (const id of npmIds) expect(got).not.toContain(id);

    const both = await page("/v1/events?ecosystem=node,npm&component=cmp-eco&since=30000", ip);
    expect(both.events.map((e) => e.id).sort()).toEqual([...nodeIds, ...npmIds].sort());
  });

  it("component=C1 returns only that component", async () => {
    const ip = "203.0.113.13";
    await seed([
      ...rows("CMA", 2, 31_001, { component: "cmp-c1" }),
      ...rows("CMB", 2, 31_003, { component: "cmp-c2" }),
    ]);
    const p = await page("/v1/events?component=cmp-c1&since=31000", ip);
    expect(p.events.map((e) => e.id)).toEqual([idFor("CMA", 0), idFor("CMA", 1)]);
  });

  it("min_severity=high returns critical and high only", async () => {
    const ip = "203.0.113.14";
    const labels = ["critical", "high", "medium", "low", "unknown"] as const;
    await seed(labels.map((label, i) => ({ id: idFor("SVA", i), cursor: 32_001 + i, ecosystem: "eco-sev", label })));
    const p = await page("/v1/events?ecosystem=eco-sev&min_severity=high", ip);
    expect(p.events.map((e) => e.severity.label)).toEqual(["critical", "high"]);
    expect(p.events.map((e) => e.id)).toEqual([idFor("SVA", 0), idFor("SVA", 1)]);
  });

  it("exploited=true returns only exploited advisories", async () => {
    const ip = "203.0.113.15";
    await seed([
      { id: idFor("XPA", 0), cursor: 33_001, ecosystem: "eco-kev", exploited: true },
      { id: idFor("XPA", 1), cursor: 33_002, ecosystem: "eco-kev", exploited: false },
      { id: idFor("XPA", 2), cursor: 33_003, ecosystem: "eco-kev", exploited: true },
    ]);
    const p = await page("/v1/events?ecosystem=eco-kev&exploited=true", ip);
    for (const e of p.events) expect(e.exploited).toBe(true);
    expect(p.events.map((e) => e.id)).toEqual([idFor("XPA", 0), idFor("XPA", 2)]);
  });

  it.each(["exploited=yes", "since=-1", "since=abc", "min_severity=severe", "limit=ten"])(
    "rejects %s with 400 JSON {error}",
    async (q) => {
      const res = await get(`/v1/events?${q}`, "203.0.113.16");
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const body = (await res.json()) as { error: unknown };
      expect(typeof body.error).toBe("string");
    },
  );

  it("an empty page keeps the client's place", async () => {
    const p = await page("/v1/events?ecosystem=eco-none&since=777", "203.0.113.17");
    expect(p).toEqual({ events: [], next_cursor: 777, has_more: false });
  });
});

describe("GET /v1/events ETag", () => {
  const ip = "203.0.113.18";
  const path = "/v1/events?ecosystem=eco-etag&limit=2";

  it("answers 304 to a matching If-None-Match and 200 when anything changes", async () => {
    await seed(rows("ETA", 2, 34_001, { ecosystem: "eco-etag" }));

    const first = await get(path, ip);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    const hit = await get(path, ip, { "If-None-Match": etag });
    expect(hit.status).toBe(304);
    expect(await hit.text()).toBe("");
    expect(hit.headers.get("etag")).toBe(etag);
    expect(hit.headers.get("cache-control")).toBe("public, max-age=60");

    expect((await get(path, ip, { "If-None-Match": `W/${etag}` })).status).toBe(304);
    expect((await get(path, ip, { "If-None-Match": `"x", ${etag}` })).status).toBe(304);

    // Negatives: no header, another ETag, other filters.
    expect((await get(path, ip)).status).toBe(200);
    expect((await get(path, ip, { "If-None-Match": '"0123456789abcdef0123456789abcdef"' })).status).toBe(200);
    expect((await get(`${path}&min_severity=low`, ip, { "If-None-Match": etag })).status).toBe(200);

    // A third matching row arrives after the page: rows 1..2 are unchanged and
    // the max cursor is the same, but has_more flips, so the ETag must change.
    await seed([{ id: idFor("ETA", 2), cursor: 34_003, ecosystem: "eco-etag" }]);
    const flipped = await get(path, ip, { "If-None-Match": etag });
    expect(flipped.status).toBe(200);
    expect(((await flipped.json()) as Page).has_more).toBe(true);
    expect(flipped.headers.get("etag")).not.toBe(etag);
  });

  it("changes the ETag when a new matching row lands in the page", async () => {
    const p = "/v1/events?ecosystem=eco-etag2";
    await seed(rows("ETB", 1, 35_001, { ecosystem: "eco-etag2" }));
    const first = await get(p, ip);
    const etag = first.headers.get("etag")!;
    await seed([{ id: idFor("ETB", 1), cursor: 35_002, ecosystem: "eco-etag2" }]);
    const second = await get(p, ip, { "If-None-Match": etag });
    expect(second.status).toBe(200);
    expect(((await second.json()) as Page).events).toHaveLength(2);
    expect(second.headers.get("etag")).not.toBe(etag);
  });
});

describe("GET /v1/events/:id and /v1/events/cve/:cve", () => {
  const ip = "203.0.113.19";

  it("returns one advisory by id, 404 JSON when unknown", async () => {
    const [doc] = await seed([{ id: idFor("QNE", 0), cursor: 36_001, cve: "CVE-2026-12345" }]);
    const res = await get(`/v1/events/${doc.id}`, ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual(doc);

    const miss = await get("/v1/events/tcs_00000000000000000000000000", ip);
    expect(miss.status).toBe(404);
    expect(miss.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(typeof ((await miss.json()) as { error: unknown }).error).toBe("string");
  });

  it("resolves a CVE (any case) to its advisory; unknown 404, malformed 400", async () => {
    const [doc] = await seed([{ id: idFor("CVA", 0), cursor: 36_101, cve: "CVE-2026-54321" }]);
    const res = await get("/v1/events/cve/cve-2026-54321", ip);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Advisory).id).toBe(doc.id);

    const miss = await get("/v1/events/cve/CVE-1999-0001", ip);
    expect(miss.status).toBe(404);
    expect(typeof ((await miss.json()) as { error: unknown }).error).toBe("string");

    const bad = await get("/v1/events/cve/not-a-cve", ip);
    expect(bad.status).toBe(400);
    expect(typeof ((await bad.json()) as { error: unknown }).error).toBe("string");
  });
});
