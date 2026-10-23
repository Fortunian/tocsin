import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NODE_DEFAULTS, parseNodeFeed } from "../../src/ingest/node-runtime";
import { defaultRegistry, runIngesters } from "../../src/ingest/registry";
import distIndex from "../fixtures/node-eol/index.json?raw";
import noUpdatesHtml from "../fixtures/node-runtime/2019-09-12-no-updates.html?raw";
import feedXml from "../fixtures/node-runtime/vulnerability.xml?raw";
import { createRuntimeFake } from "./runtime-fake.tcs-6";

// TCS-69 reproduction. It imports only modules that exist before the fix, so
// it runs (and fails) at the merge base too. The recorded feed and the
// node-runtime row as migration 0015 leaves it (max_posts 20, backfill_days
// 4000). The 2019 "no updates" post answers its RECORDED page
// (tests/fixtures/node-runtime/README.tcs-69.md); every other post answers a
// SYNTHETIC post as in node-history.tcs-32 (one CVE heading on 4.x, fixed in v4.9.1).
const FEED = NODE_DEFAULTS.feed_url;
const INDEX = NODE_DEFAULTS.dist_index_url;
const NO_UPDATES = "https://nodejs.org/en/blog/vulnerability/september-2019-openssl-no-updates";
const NOW = new Date("2026-10-23T01:00:00Z");
const POSTS = parseNodeFeed(feedXml)
  .filter((p) => p.title.toLowerCase().includes("security release"))
  .sort((a, b) => (a.published < b.published ? -1 : 1));

function post(i: number): string {
  return `<main><h2>Fixture issue ${i} (CVE-2015-${String(90000 + i)}) - (high)</h2>
<p>This vulnerability affects Node.js 4.x</p>
<h2>Downloads and release details</h2><ul><li>Node.js v4.9.1</li></ul></main>`;
}

function routes(): Record<string, string> {
  const r: Record<string, string> = { [FEED]: feedXml, [INDEX]: distIndex };
  POSTS.forEach((p, i) => (r[p.link] = post(i)));
  r[NO_UPDATES] = noUpdatesHtml;
  return r;
}

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((() => {
    throw new Error("real network call in a TCS-69 repro test");
  }) as never);
});
afterAll(() => fetchSpy.mockRestore());

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'node-runtime'").run();
  await env.DB.prepare("UPDATE sources SET coverage_since = NULL, last_error = NULL, last_ok_at = NULL WHERE id = 'node-runtime'").run();
  // The KV keys of the base commit (literals: the fix removes them).
  for (const k of ["cursor:node-runtime", "cursor:node-runtime:parser", "node-dist-index"]) await env.CURSORS.delete(k);
});

describe("TCS-69 repro", () => {
  it("R1: the walk reads the recorded 2019 'no updates' post and the source stays ok on every run", async () => {
    expect(POSTS.map((p) => p.link)).toContain(NO_UPDATES);
    const fake = createRuntimeFake(routes());
    fetchSpy.mockImplementation(fake.fetch as never);
    await env.DB.prepare("UPDATE sources SET enabled = CASE WHEN id = 'node-runtime' THEN 1 ELSE 0 END").run();
    try {
      // 48 posts, 20 per run: three runs walk the whole feed.
      for (let run = 1; run <= 3; run++) {
        const [o] = await runIngesters(env, defaultRegistry, () => NOW);
        const row = await env.DB.prepare("SELECT last_ok_at, last_error FROM sources WHERE id = 'node-runtime'").first<{ last_ok_at: string | null; last_error: string | null }>();
        expect(row?.last_error ?? null, `run ${run}`).toBeNull();
        expect(row?.last_ok_at, `run ${run}`).toBe(NOW.toISOString());
        expect(o.status, `run ${run}`).toBe("ok");
      }
      expect(fake.count(NO_UPDATES)).toBe(1);
    } finally {
      fetchSpy.mockImplementation((() => {
        throw new Error("real network call in a TCS-69 repro test");
      }) as never);
      await env.DB.prepare("UPDATE sources SET enabled = 1").run();
    }
  });
});
