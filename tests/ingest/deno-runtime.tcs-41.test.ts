import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DENO_DEFAULTS } from "../../src/ingest/deno-runtime";
import { GithubHttpError, GithubLinkError } from "../../src/ingest/github-advisories";
import { cursorKey, etagKey, RELEASE_DEDUP_SQL } from "../../src/ingest/github-runtime";
import { defaultRegistry, runIngesters, type SourceOutcome } from "../../src/ingest/registry";
import type { RunResult } from "../../src/ingest/types";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import advisoriesJson from "../fixtures/deno-runtime/advisories.json?raw";
import releasesJson from "../fixtures/deno-runtime/releases.json?raw";
import { get } from "../routes/seed.tcs-3";
import { createGhFake, type GhAnswer, type GhFake } from "./github-fake.tcs-41";

// Fixtures: SYNTHETIC entries that carry the real range strings (tests/fixtures/deno-runtime/README.md).
const SOURCE = "deno-runtime";
const ADV = "https://api.github.com/repos/denoland/deno/security-advisories";
const FIRST = `${ADV}?state=published&sort=published&direction=desc&per_page=100`;
const PAGE2 = `${ADV}?state=published&sort=published&direction=desc&per_page=100&after=Y3Vyc29yOnYyOpK0`;
const RELEASES = "https://api.github.com/repos/denoland/deno/releases?per_page=100";
const ETAG = 'W/"deno-fixture-etag-1"';
const NOW = new Date("2026-10-23T01:00:00Z");
const ITEMS = JSON.parse(advisoriesJson) as { ghsa_id: string; published_at: string }[];

const throwing = (input: unknown) => {
  throw new Error(`real network call in a deno-runtime test: ${String(input)}`);
};

let fetchSpy: MockInstance;
let fake: GhFake;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(throwing as never);
});
afterAll(() => {
  fetchSpy.mockRestore();
});

function useFake(routes: Record<string, string | GhAnswer>): GhFake {
  fake = createGhFake(routes);
  fetchSpy.mockImplementation(fake.fetch as never);
  return fake;
}

const base = (over: Record<string, string | GhAnswer> = {}) => ({ [FIRST]: { body: advisoriesJson, etag: ETAG }, [RELEASES]: releasesJson, ...over });

// Only deno-runtime is enabled; the production registry and runIngesters run it (D2).
async function runDeno(opts: { env?: Partial<typeof env>; config?: Record<string, unknown> } = {}): Promise<SourceOutcome> {
  await env.DB.prepare("UPDATE sources SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END").bind(SOURCE).run();
  if (opts.config) await env.DB.prepare("UPDATE sources SET config_json = ? WHERE id = ?").bind(JSON.stringify(opts.config), SOURCE).run();
  try {
    const outcomes = await runIngesters({ ...env, ...opts.env }, defaultRegistry, () => NOW);
    expect(outcomes.map((o) => o.source)).toEqual([SOURCE]);
    return outcomes[0];
  } finally {
    await env.DB.prepare("UPDATE sources SET enabled = 1, config_json = CASE WHEN id = ? THEN '{}' ELSE config_json END").bind(SOURCE).run();
  }
}

function resultOf(o: SourceOutcome): RunResult {
  if (o.status !== "ok") throw new Error(`deno-runtime did not run ok: ${JSON.stringify(o)}`);
  return o.result;
}

async function denoDocs(): Promise<Map<string, Advisory>> {
  const { results } = await env.DB.prepare(
    "SELECT s.source_id, a.doc_json, a.ecosystem, a.component FROM advisories a JOIN advisory_sources s ON s.advisory_id = a.id WHERE s.source = ? ORDER BY s.source_id",
  )
    .bind(SOURCE)
    .all<{ source_id: string; doc_json: string; ecosystem: string; component: string }>();
  return new Map(results.map((r) => [r.source_id, { ...(JSON.parse(r.doc_json) as Advisory), ecosystem: r.ecosystem, component: r.component }]));
}

const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM advisories").first<{ n: number }>())!.n;
const maxCursor = async () => (await env.DB.prepare("SELECT MAX(cursor) AS m FROM advisories").first<{ m: number }>())!.m;
const sourceRow = () => env.DB.prepare("SELECT last_error, last_warning, last_ok_at FROM sources WHERE id = ?").bind(SOURCE).first<{ last_error: string | null; last_warning: string | null; last_ok_at: string | null }>();

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = ?)").bind(SOURCE).run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = ?").bind(SOURCE).run();
  await env.DB.prepare("UPDATE sources SET last_error = NULL, last_warning = NULL, last_ok_at = NULL WHERE id = ?").bind(SOURCE).run();
  await env.CURSORS.delete(cursorKey(SOURCE));
  await env.CURSORS.delete(etagKey(SOURCE));
  // TCS-32: a source with no coverage_since reads its whole history once
  // (tests/ingest/github-runtime-coverage.tcs-32.test.ts). These tests pin the
  // cursor and ETag rules of a covered source, so each one starts covered.
  await env.DB.prepare("UPDATE sources SET coverage_since = '2020-01-01T00:00:00Z' WHERE id = ?").bind(SOURCE).run();
  fetchSpy.mockImplementation(throwing as never);
});

const NEWEST = ITEMS[0].published_at;

describe("deno-runtime: first run on the recorded page", () => {
  it("the sources row exists and is enabled (migration 0013)", async () => {
    const row = await env.DB.prepare("SELECT kind, enabled, config_json FROM sources WHERE id = ?").bind(SOURCE).first();
    expect(row).toEqual({ kind: "deno-runtime", enabled: 1, config_json: "{}" });
  });

  it("stores one deno/deno advisory per runtime entry with the right fixed versions and ranges", async () => {
    useFake(base());
    const r = resultOf(await runDeno());
    expect(r).toMatchObject({ fetched: 12, upserted: 10, unchanged: 0, errors: [] });
    const docs = await denoDocs();
    expect(docs.size).toBe(10);
    for (const d of docs.values()) {
      expect(d.ecosystem).toBe("deno");
      expect(d.component).toBe("deno");
      expect(validateAdvisory(d).ok).toBe(true);
    }
    const f = (id: string) => docs.get(id)!;
    expect(f("GHSA-2222-2222-2222").fixed_versions).toEqual(["2.7.5"]);
    expect(f("GHSA-2222-2222-2222").affected).toEqual([{ introduced: "0", fixed: "2.7.5" }]);
    expect(f("GHSA-2222-2222-2222").severity).toEqual({ label: "high", score: 7.5 });
    expect(f("GHSA-2222-2222-2222").action).toBe("Upgrade deno to 2.7.5 or later.");
    expect(f("GHSA-2222-2222-2222").references).toEqual([
      "https://github.com/denoland/deno/security/advisories/GHSA-2222-2222-2222",
      "https://www.cve.org/CVERecord?id=CVE-2099-41001",
    ]);
    expect(f("GHSA-3333-3333-3333").fixed_versions).toEqual(["2.7.10"]);
    expect(f("GHSA-3333-3333-3333").severity).toEqual({ label: "medium" });
    expect(f("GHSA-4444-4444-4444").fixed_versions).toEqual(["2.2.15", "2.5.2"]);
    expect(f("GHSA-4444-4444-4444").action).toBe("Upgrade deno to 2.2.15 (2.2.x) or 2.5.2 or later.");
    expect(f("GHSA-5555-5555-5555").affected).toEqual([
      { introduced: "0", fixed: "2.1.13" },
      { introduced: "2.2.0", fixed: "2.2.13" },
      { introduced: "2.3.0", fixed: "2.3.3" },
    ]);
    expect(f("GHSA-6666-6666-6666").affected).toEqual([{ introduced: "1.46.1", fixed: "2.1.7" }]);
    expect(f("GHSA-6666-6666-6666").severity).toEqual({ label: "high", score: 8.7 });
    expect(f("GHSA-7777-7777-7777").fixed_versions).toEqual(["1.46.4", "2.1.2"]);
    expect(f("GHSA-8888-8888-8888").fixed_versions).toEqual(["1.40.3"]);
    expect(f("GHSA-8888-8888-8888").affected).toEqual([{ introduced: "1.36.2", fixed: "1.40.3" }]);
    expect(f("GHSA-9999-9999-9999").affected).toEqual([{ introduced: "1.34.0", fixed: "1.34.1" }]);
    expect(f("GHSA-2222-3333-4444").affected).toEqual([{ introduced: "1.5.0", fixed: "1.10.2" }]);
    expect(f("GHSA-3333-4444-5555").affected).toEqual([{ introduced: "1.9.0", fixed: "2.2.5" }]);
    expect(f("GHSA-3333-4444-5555").severity).toEqual({ label: "critical", score: 9.3 });
    // The crate-only and the withdrawn entries never produce a doc; they are warnings.
    expect(docs.has("GHSA-4444-5555-6666")).toBe(false);
    expect(docs.has("GHSA-5555-6666-7777")).toBe(false);
    expect(r.warnings).toEqual(["GHSA-5555-6666-7777: withdrawn", "GHSA-4444-5555-6666: no deno package entry"]);
    expect((await sourceRow())?.last_warning).toContain("GHSA-4444-5555-6666: no deno package entry");
    // One advisories page, one releases read for the entry with no patched version.
    expect(fake.urls()).toEqual([FIRST, RELEASES]);
    expect(await env.CURSORS.get(cursorKey(SOURCE))).toBe(NEWEST);
    expect(await env.CURSORS.get(etagKey(SOURCE))).toBe(ETAG);
  });
});

describe("deno-runtime: second run", () => {
  it("a 304 on the stored ETag: all zero, no write, cursor unchanged", async () => {
    useFake(base());
    await runDeno();
    const n = await count();
    const m = await maxCursor();
    useFake(base());
    const r = resultOf(await runDeno());
    expect(r).toMatchObject({ fetched: 0, upserted: 0, unchanged: 0, errors: [] });
    expect(fake.calls.map((c) => [c.url, c.status])).toEqual([[FIRST, 304]]);
    expect(fake.calls[0].headers["if-none-match"]).toBe(ETAG);
    expect(await count()).toBe(n);
    expect(await maxCursor()).toBe(m);
    expect((await sourceRow())?.last_ok_at).toBe(NOW.toISOString());
  });

  it("a 200 with no ETag: upserted 0, unchanged for every item at or after the cursor, no new rows", async () => {
    useFake(base());
    await runDeno();
    const n = await count();
    const m = await maxCursor();
    useFake(base({ [FIRST]: advisoriesJson }));
    const r = resultOf(await runDeno());
    expect(r.upserted).toBe(0);
    // Only the newest item is at the cursor; the next one is older and ends the read.
    expect(r.unchanged).toBe(1);
    expect(r.fetched).toBe(1);
    expect(await count()).toBe(n);
    expect(await maxCursor()).toBe(m);
    // The page had no ETag, so the stored one is removed.
    expect(await env.CURSORS.get(etagKey(SOURCE))).toBeNull();
  });

  it("a full re-read (cursor and ETag removed) gives unchanged for all 10 and 0 releases calls", async () => {
    useFake(base());
    await runDeno();
    await env.CURSORS.delete(cursorKey(SOURCE));
    await env.CURSORS.delete(etagKey(SOURCE));
    useFake(base());
    const r = resultOf(await runDeno());
    expect(r).toMatchObject({ fetched: 12, upserted: 0, unchanged: 10, errors: [] });
    // GHSA-8888 is already in advisory_sources: the releases read is skipped (dedup before spend).
    expect(fake.count(RELEASES)).toBe(0);
  });

  it("the releases dedup seek uses the advisory_sources primary key", async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${RELEASE_DEDUP_SQL}`).bind(SOURCE, "GHSA-8888-8888-8888").all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toContain("sqlite_autoindex_advisory_sources_1");
    expect(plan).not.toMatch(/SCAN advisory_sources\b(?! USING)/);
  });
});

describe("deno-runtime: pagination and the cursor", () => {
  const page1 = JSON.stringify(ITEMS.slice(0, 6));
  const page2 = JSON.stringify(ITEMS.slice(6));

  it("paginates through the Link next header when no cursor is stored", async () => {
    useFake(base({ [FIRST]: { body: page1, etag: ETAG, next: PAGE2 }, [PAGE2]: page2 }));
    const r = resultOf(await runDeno());
    expect(r).toMatchObject({ fetched: 12, upserted: 10 });
    expect(fake.urls()).toEqual([FIRST, PAGE2, RELEASES]);
    // Only page 1 is conditional.
    expect(fake.calls[1].headers["if-none-match"]).toBeUndefined();
  });

  it("an item older than the stored cursor ends the read: page 2 is not fetched", async () => {
    await env.CURSORS.put(cursorKey(SOURCE), ITEMS[4].published_at);
    useFake(base({ [FIRST]: { body: page1, etag: ETAG, next: PAGE2 }, [PAGE2]: page2 }));
    const r = resultOf(await runDeno());
    expect(fake.count(PAGE2)).toBe(0);
    expect(r.fetched).toBe(5);
    expect(r.upserted).toBe(5);
    expect(await env.CURSORS.get(cursorKey(SOURCE))).toBe(NEWEST);
  });

  it("the cursor never moves back", async () => {
    const later = "2026-12-01T00:00:00Z";
    await env.CURSORS.put(cursorKey(SOURCE), later);
    useFake(base());
    const r = resultOf(await runDeno());
    expect(r.fetched).toBe(0);
    expect(await env.CURSORS.get(cursorKey(SOURCE))).toBe(later);
  });

  it("a next link on another origin is not fetched and the run fails", async () => {
    const evil = "https://evil.example/repos/denoland/deno/security-advisories?after=x";
    useFake(base({ [FIRST]: { body: page1, etag: ETAG, next: evil }, [evil]: page2 }));
    const o = await runDeno();
    expect(o.status).toBe("failed");
    expect(o.status === "failed" && o.error).toContain(new GithubLinkError(evil, "https://api.github.com").name);
    expect(fake.count(evil)).toBe(0);
    expect(await env.CURSORS.get(cursorKey(SOURCE))).toBeNull();
    expect(await env.CURSORS.get(etagKey(SOURCE))).toBeNull();
  });

  it("the page cap (config max_pages: 1) marks the run incomplete with an error and writes no cursor", async () => {
    useFake(base({ [FIRST]: { body: page1, etag: ETAG, next: PAGE2 }, [PAGE2]: page2 }));
    const o = await runDeno({ config: { max_pages: 1 } });
    expect(o.status).toBe("failed");
    if (o.status !== "failed") return;
    expect(o.result?.incomplete).toBe(true);
    expect(o.error).toContain("more than 1 pages");
    expect(fake.count(PAGE2)).toBe(0);
    expect(await env.CURSORS.get(cursorKey(SOURCE))).toBeNull();
    expect(await env.CURSORS.get(etagKey(SOURCE))).toBeNull();
  });
});

describe("deno-runtime: seam and config", () => {
  it("seam: an HTTP 403 on page 1 fails the source and leaves the cursor and ETag unchanged", async () => {
    await env.CURSORS.put(cursorKey(SOURCE), "2026-10-01T00:00:00Z");
    await env.CURSORS.put(etagKey(SOURCE), ETAG);
    useFake(base({ [FIRST]: { status: 403, body: '{"message":"API rate limit exceeded"}' } }));
    const o = await runDeno();
    expect(o.status).toBe("failed");
    expect(o.status === "failed" && o.error).toContain(new GithubHttpError(403, FIRST).message);
    expect((await sourceRow())?.last_error).toContain("HTTP 403");
    expect(await env.CURSORS.get(cursorKey(SOURCE))).toBe("2026-10-01T00:00:00Z");
    expect(await env.CURSORS.get(etagKey(SOURCE))).toBe(ETAG);
    expect((await denoDocs()).size).toBe(0);
  });

  it("seam: the authorization header is sent only when GITHUB_TOKEN is set, and with the GitHub headers", async () => {
    useFake(base());
    await runDeno({ env: { GITHUB_TOKEN: undefined } });
    expect(fake.calls[0].headers.authorization).toBeUndefined();
    expect(fake.calls[0].headers["if-none-match"]).toBeUndefined();
    await env.CURSORS.delete(cursorKey(SOURCE));
    useFake(base());
    await runDeno({ env: { GITHUB_TOKEN: " ghp_fixture_token\n" } });
    for (const c of fake.calls) {
      expect(c.headers.authorization).toBe("Bearer ghp_fixture_token");
      expect(c.headers.accept).toBe("application/vnd.github+json");
      expect(c.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(c.headers["user-agent"]).toBe("tocsin.sh");
    }
    // The second run sent the stored ETag.
    expect(fake.calls[0].headers["if-none-match"]).toBe(ETAG);
  });

  it("config: a bad exclude_package_pattern fails the source before any read", async () => {
    useFake(base());
    const o = await runDeno({ config: { exclude_package_pattern: "(" } });
    expect(o.status).toBe("failed");
    expect(o.status === "failed" && o.error).toContain("exclude_package_pattern");
    expect(fake.calls).toEqual([]);
  });

  it("config: page_size and advisories_url come from config_json", async () => {
    const url = "https://api.github.com/repos/denoland/deno/security-advisories?state=published&sort=published&direction=desc&per_page=50";
    useFake({ [url]: "[]" });
    const r = resultOf(await runDeno({ config: { page_size: 50, advisories_url: ADV } }));
    expect(r.fetched).toBe(0);
    expect(fake.urls()).toEqual([url]);
    expect(DENO_DEFAULTS.page_size).toBe(100);
  });
});

describe("deno-runtime: check through the worker", () => {
  const url = "https://github.com/denoland/deno/security/advisories/GHSA-6666-6666-6666";
  type Body = { affected: { url: string; fixed_in: string | null; dependency: { ecosystem: string; name: string } }[] };

  it("check: deno=2.1.0 lists GHSA-6666 with fixed_in 2.1.7; 2.1.7 and 1.46.0 do not", async () => {
    useFake(base());
    await runDeno();
    const hit = (await (await get("/v1/check?deno=2.1.0&bun=1.1.30", "192.0.2.211")).json()) as Body;
    expect(hit.affected.find((a) => a.url === url)).toMatchObject({ fixed_in: "2.1.7", dependency: { ecosystem: "deno", name: "deno" } });
    const patched = (await (await get("/v1/check?deno=2.1.7", "192.0.2.212")).json()) as Body;
    expect(patched.affected.map((a) => a.url)).not.toContain(url);
    const below = (await (await get("/v1/check?deno=1.46.0", "192.0.2.213")).json()) as Body;
    expect(below.affected.map((a) => a.url)).not.toContain(url);
    const lower = (await (await get("/v1/check?deno=1.46.1", "192.0.2.214")).json()) as Body;
    expect(lower.affected.find((a) => a.url === url)).toMatchObject({ fixed_in: "2.1.7" });
  });

  it("check: deno=1.40.2 lists GHSA-8888 with fixed_in 1.40.3 (from releases); 1.40.3 does not", async () => {
    const u = "https://github.com/denoland/deno/security/advisories/GHSA-8888-8888-8888";
    useFake(base());
    await runDeno();
    const hit = (await (await get("/v1/check?deno=1.40.2", "192.0.2.215")).json()) as Body;
    expect(hit.affected.find((a) => a.url === u)).toMatchObject({ fixed_in: "1.40.3" });
    const fixed = (await (await get("/v1/check?deno=1.40.3", "192.0.2.216")).json()) as Body;
    expect(fixed.affected.map((a) => a.url)).not.toContain(u);
  });
});
