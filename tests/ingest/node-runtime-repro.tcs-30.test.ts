import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeNodePost, nodeRuntime } from "../../src/ingest/node-runtime";
import type { IngestContext } from "../../src/ingest/types";
import julyHtml from "../fixtures/node-runtime/2026-07-29.html?raw";
import preHtml from "../fixtures/node-runtime/2026-10-14-pre.html?raw";
import octHtml from "../fixtures/node-runtime/2026-10-21.html?raw";
import indexJuly from "../fixtures/node-runtime/index-since-2026-07.json?raw";
import indexJson from "../fixtures/node-runtime/index.json?raw";
import feedXml from "../fixtures/node-runtime/vulnerability.xml?raw";
import { clearNodeLedger, markNodePostsRead } from "./node-ledger-seed.tcs-69";
import { createRuntimeFake } from "./runtime-fake.tcs-6";

// TCS-30 reproduction. It uses only the exports that existed before the fix,
// so it runs (and fails) at the merge base too.
const FEED = "https://nodejs.org/en/feed/vulnerability.xml";
const OCT = "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases";
const JULY = "https://nodejs.org/en/blog/vulnerability/july-2026-security-releases";
const INDEX = "https://nodejs.org/dist/index.json";
const NOW = "2026-10-22T16:00:00Z";

function ctxAt(fetchFn: typeof fetch, now: number): IngestContext {
  return { env, source: { id: "node-runtime", kind: "node-runtime", config: {} }, now: () => new Date(now), fetch: fetchFn };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'node-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'node-runtime'").run();
  // No cached dist index, and every post before the October post read with the
  // current parser revision (TCS-69: ok ledger rows, where it was a KV cursor
  // and parser key before).
  await env.CURSORS.delete("node-dist-index");
  await clearNodeLedger();
  await markNodePostsRead("2026-10-01T00:00:00Z");
});

describe("TCS-30 repro", () => {
  it("repro: the recorded 2026-10-14 pre-announcement post gives no error", () => {
    const r = normalizeNodePost({ link: OCT, published: "2026-10-21T22:00:00Z" }, preHtml, new Set());
    expect(r.errors).toEqual([]);
    expect(r.docs).toEqual([]);
  });

  it("repro: the recorded July post yields 11 advisories and no error", () => {
    const dist = new Set((JSON.parse(indexJuly) as { version: string }[]).map((e) => e.version));
    const r = normalizeNodePost({ link: JULY, published: "2026-07-29T00:00:00Z" }, julyHtml, dist);
    expect(r.errors).toEqual([]);
    expect(r.docs).toHaveLength(11);
  });

  it("repro: two runs 30 minutes apart download the dist index once", async () => {
    const fake = createRuntimeFake({ [FEED]: feedXml, [OCT]: octHtml, [INDEX]: indexJson });
    await nodeRuntime.run(ctxAt(fake.fetch, Date.parse(NOW)));
    await nodeRuntime.run(ctxAt(fake.fetch, Date.parse(NOW) + 30 * 60_000));
    expect(fake.count(INDEX)).toBe(1);
  });
});
