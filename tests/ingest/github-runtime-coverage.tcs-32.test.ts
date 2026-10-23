import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cursorKey, etagKey } from "../../src/ingest/github-runtime";
import { defaultRegistry, runIngesters, type SourceOutcome } from "../../src/ingest/registry";
import advisoriesJson from "../fixtures/deno-runtime/advisories.json?raw";
import releasesJson from "../fixtures/deno-runtime/releases.json?raw";
import { createGhFake, type GhAnswer, type GhFake } from "./github-fake.tcs-41";

// The GitHub runtime ingesters read their whole history once while
// sources.coverage_since is NULL (TCS-32). deno-runtime, through the
// production registry, on the TCS-41 fixtures (SYNTHETIC entries with real
// range strings, tests/fixtures/deno-runtime/README.md).
const SOURCE = "deno-runtime";
const ADV = "https://api.github.com/repos/denoland/deno/security-advisories";
const FIRST = `${ADV}?state=published&sort=published&direction=desc&per_page=100`;
const PAGE2 = `${ADV}?state=published&sort=published&direction=desc&per_page=100&after=Y3Vyc29yOnYyOpK0`;
const RELEASES = "https://api.github.com/repos/denoland/deno/releases?per_page=100";
const ETAG = 'W/"deno-fixture-etag-32"';
const NOW = new Date("2026-10-23T01:00:00Z");
const ITEMS = JSON.parse(advisoriesJson) as { ghsa_id: string; published_at: string }[];
const page1 = JSON.stringify(ITEMS.slice(0, 6));
const page2 = JSON.stringify(ITEMS.slice(6));

let fetchSpy: MockInstance;
let fake: GhFake;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((() => {
    throw new Error("real network call in a github-runtime-coverage test");
  }) as never);
});
afterAll(() => fetchSpy.mockRestore());

function useFake(routes: Record<string, string | GhAnswer>): void {
  fake = createGhFake(routes);
  fetchSpy.mockImplementation(fake.fetch as never);
}

const paged = () => ({ [FIRST]: { body: page1, etag: ETAG, next: PAGE2 }, [PAGE2]: page2, [RELEASES]: releasesJson });

async function runDeno(config?: Record<string, unknown>): Promise<SourceOutcome> {
  await env.DB.prepare("UPDATE sources SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END").bind(SOURCE).run();
  if (config) await env.DB.prepare("UPDATE sources SET config_json = ? WHERE id = ?").bind(JSON.stringify(config), SOURCE).run();
  try {
    const out = await runIngesters(env, defaultRegistry, () => NOW);
    return out[0];
  } finally {
    await env.DB.prepare("UPDATE sources SET enabled = 1, config_json = CASE WHEN id = ? THEN '{}' ELSE config_json END").bind(SOURCE).run();
  }
}

const coverage = async () => (await env.DB.prepare("SELECT coverage_since FROM sources WHERE id = ?").bind(SOURCE).first<{ coverage_since: string | null }>())!.coverage_since;
const oldestStored = async () =>
  (await env.DB.prepare("SELECT MIN(a.published_at) AS m FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = ?").bind(SOURCE).first<{ m: string | null }>())!.m;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = ?)").bind(SOURCE).run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = ?").bind(SOURCE).run();
  await env.DB.prepare("UPDATE sources SET coverage_since = NULL, last_error = NULL WHERE id = ?").bind(SOURCE).run();
  await env.CURSORS.delete(cursorKey(SOURCE));
  await env.CURSORS.delete(etagKey(SOURCE));
});

describe("github runtime coverage", () => {
  it("coverage_since NULL with a stored cursor and ETag: the run ignores both, reads every page, and sets coverage_since", async () => {
    await env.CURSORS.put(cursorKey(SOURCE), ITEMS[4].published_at);
    await env.CURSORS.put(etagKey(SOURCE), ETAG);
    useFake(paged());
    const o = await runDeno();
    expect(o.status, JSON.stringify(o)).toBe("ok");
    expect(fake.count(PAGE2)).toBe(1);
    expect(fake.calls[0].headers["if-none-match"]).toBeUndefined();
    const oldest = await oldestStored();
    expect(oldest).not.toBeNull();
    expect(await coverage()).toBe(oldest);
    // The cursor is the newest item; it never moves back.
    expect(await env.CURSORS.get(cursorKey(SOURCE))).toBe(ITEMS[0].published_at);

    // Covered: the next run follows the cursor and the ETag again.
    useFake(paged());
    await runDeno();
    expect(fake.calls.map((c) => c.status)).toEqual([304]);
    expect(await coverage()).toBe(oldest);
  });

  it("a run stopped by max_pages does not set coverage_since", async () => {
    useFake(paged());
    const o = await runDeno({ max_pages: 1 });
    expect(o.status).toBe("failed");
    expect(fake.count(PAGE2)).toBe(0);
    expect(await coverage()).toBeNull();
  });

  it("a complete run that reads no advisory sets coverage_since to the run time", async () => {
    useFake({ [FIRST]: { body: "[]", etag: ETAG } });
    const o = await runDeno();
    expect(o.status).toBe("ok");
    expect(await coverage()).toBe(NOW.toISOString());
  });
});
