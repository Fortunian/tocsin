import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { NODE_DIST_KEY } from "../../src/ingest/node-runtime-dist";
import { PHP_CURSOR_KEY } from "../../src/ingest/php-runtime";
import type { Advisory } from "../../src/schema/advisory";
import { renderPostText, weightedLength, type TextOptions } from "../../src/social/text";
import nodePost from "../fixtures/node-runtime/2026-10-21.html?raw";
import nodeIndex from "../fixtures/node-runtime/index.json?raw";
import nodeFeed from "../fixtures/node-runtime/vulnerability.xml?raw";
import phpNews from "../fixtures/php-runtime/2026-10-21.html?raw";
import phpReleases from "../fixtures/php-runtime/releases.xml?raw";
import phpList from "../fixtures/php-runtime/security-advisories.page1.json?raw";
import { clearNodeLedger, markNodePostsRead } from "../ingest/node-ledger-seed.tcs-69";
import { createRuntimeFake } from "../ingest/runtime-fake.tcs-6";

// TCS-106 post text: deterministic from the stored doc, at most
// social.x.max_chars after X's weighting (a URL weighs social.x.url_chars).
// The 2026-10-21 Node and PHP docs come from the recorded fixtures through
// the production cron (worker.scheduled) and the runtime ingest fakes.

const ROUTES = {
  "https://nodejs.org/en/feed/vulnerability.xml": nodeFeed,
  "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases": nodePost,
  "https://nodejs.org/dist/index.json": nodeIndex,
  "https://www.php.net/index.php": phpNews,
  "https://www.php.net/releases/feed.php": phpReleases,
  "https://api.github.com/repos/php/php-src/security-advisories?state=published&sort=published&direction=desc&per_page=100": phpList,
};
const OPTS: TextOptions = { maxChars: 280, urlChars: 23, minSummaryChars: 60 };
const docs: Advisory[] = [];

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await env.DB.prepare("UPDATE sources SET enabled = 0").run();
  await env.DB.prepare("UPDATE sources SET enabled = 1, config_json = '{}' WHERE id IN ('node-runtime', 'php-runtime')").run();
  await clearNodeLedger();
  await markNodePostsRead("2026-10-01T00:00:00Z");
  await env.CURSORS.delete(NODE_DIST_KEY);
  await env.CURSORS.put(PHP_CURSOR_KEY, "2026-10-01T00:00:00Z");
  const fake = createRuntimeFake(ROUTES);
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() }), env, ctx);
  await waitOnExecutionContext(ctx);
  spy.mockRestore();
  const { results } = await env.DB.prepare(
    "SELECT a.doc_json FROM advisories a JOIN advisory_sources s ON s.advisory_id = a.id WHERE s.source IN ('node-runtime', 'php-runtime')",
  ).all<{ doc_json: string }>();
  for (const r of results) docs.push(JSON.parse(r.doc_json) as Advisory);
});
afterAll(() => vi.restoreAllMocks());

const bySummary = (s: string) => {
  const d = docs.find((x) => x.summary === s);
  if (!d) throw new Error(`no stored doc with summary ${s}`);
  return d;
};

describe("renderPostText on the 2026-10-21 fixtures", () => {
  it("T1: Node.js Brotli advisory", () => {
    const d = bySummary("Node.js Brotli decoder out-of-bounds write permits remote code execution");
    expect(renderPostText(d, OPTS)).toBe(
      `Node.js 22.x, 24.x, 26.x: Node.js Brotli decoder out-of-bounds write permits remote code execution. Severity high, fixed in 22.23.4, 24.22.1, 26.12.1. https://tocsin.sh/advisories/${d.id}`,
    );
  });

  it("T2: PHP RCE via OOM corruption advisory", () => {
    const d = bySummary("RCE via OOM corruption");
    expect(renderPostText(d, OPTS)).toBe(
      `PHP 8.2.x, 8.3.x, 8.4.x, 8.5.x: RCE via OOM corruption. Severity critical, fixed in 8.2.35, 8.3.36, 8.4.27, 8.5.12. https://tocsin.sh/advisories/${d.id}`,
    );
  });

  it("T3: every stored fixture doc renders within 280 weighted chars", () => {
    expect(docs.length).toBe(12);
    for (const d of docs) expect(weightedLength(renderPostText(d, OPTS), OPTS.urlChars)).toBeLessThanOrEqual(280);
  });
});

describe("length budget", () => {
  const base: Advisory = {
    id: "tcs_01M5Z384C5PZZGS6060GVQM79Y",
    cve_ids: [],
    ecosystem: "node",
    component: "node",
    affected: [],
    fixed_versions: ["24.22.1"],
    severity: { label: "critical" },
    exploited: false,
    published_at: "2026-10-27T00:00:00Z",
    modified_at: "2026-10-27T00:00:00Z",
    summary: "short",
    action: "a",
    references: [],
    sources: [{ source: "node-runtime", source_id: "x", url: "https://example.test/x" }],
  };
  const URL = "https://tocsin.sh/advisories/tcs_01M5Z384C5PZZGS6060GVQM79Y";

  it("B1: a URL weighs url_chars whatever its length; a CJK char weighs 2", () => {
    expect(weightedLength(`ab ${URL}`, 23)).toBe(3 + 23);
    expect(weightedLength("漏洞", 23)).toBe(4);
    expect(weightedLength("é…", 23)).toBe(1 + 2);
  });

  it("B2: a 249-char summary is cut with … and the URL stays whole", () => {
    const t = renderPostText({ ...base, summary: "word ".repeat(50).trim() }, OPTS);
    expect(t).toContain("…");
    expect(t.endsWith(` ${URL}`)).toBe(true);
    expect(weightedLength(t, 23)).toBeLessThanOrEqual(280);
    expect(weightedLength(t, 23)).toBeGreaterThan(270);
  });

  it("B3: 12 fixed versions collapse to +k more and the text fits", () => {
    const fixed = Array.from({ length: 12 }, (_, i) => `${10 + i * 2}.123.456`);
    const t = renderPostText({ ...base, fixed_versions: fixed, summary: "S".repeat(120) }, OPTS);
    expect(t).toMatch(/ \+\d+ more/);
    expect(t.endsWith(` ${URL}`)).toBe(true);
    expect(weightedLength(t, 23)).toBeLessThanOrEqual(280);
  });

  it("B4: no fixed version reads 'no fixed version yet' and takes lines from affected", () => {
    const t = renderPostText({ ...base, fixed_versions: [], affected: [{ introduced: "24.0.0" }] }, OPTS);
    expect(t).toBe(`Node.js 24.x: short. Severity critical, no fixed version yet. ${URL}`);
  });

  it("B5: a Go toolchain row reads Go with major.minor lines", () => {
    const t = renderPostText({ ...base, ecosystem: "Go", component: "stdlib", fixed_versions: ["1.25.3", "1.24.9"] }, OPTS);
    expect(t).toBe(`Go 1.24.x, 1.25.x: short. Severity critical, fixed in 1.24.9, 1.25.3. ${URL}`);
  });
});
