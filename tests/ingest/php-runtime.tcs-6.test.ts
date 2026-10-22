import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { fetchGhsa, PhpHttpError } from "../../src/ingest/php-runtime-client";
import {
  normalizePhpAdvisory,
  parsePhpNews,
  parsePhpPost,
  parsePhpReleases,
  PHP_CURSOR_KEY,
  PHP_DEDUP_SQL,
  phpRuntime,
} from "../../src/ingest/php-runtime";
import type { IngestContext } from "../../src/ingest/types";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import ghsa6wmf from "../fixtures/php-runtime/GHSA-6wmf-4rv5-p3rp.json?raw";
import ghsaW8hw from "../fixtures/php-runtime/GHSA-w8hw-w9fx-j79w.json?raw";
import newsHtml from "../fixtures/php-runtime/2026-10-21.html?raw";
import releasesXml from "../fixtures/php-runtime/releases.xml?raw";
import { createRuntimeFake, type FakeAnswer } from "./runtime-fake.tcs-6";

// Fixtures: recorded from php.net and api.github.com on 2026-10-22 (tests/fixtures/php-runtime/README.md).
const NEWS = "https://www.php.net/index.php";
const RELEASES = "https://www.php.net/releases/feed.php";
const GHSA_BASE = "https://api.github.com/repos/php/php-src/security-advisories";
const W8HW = `${GHSA_BASE}/GHSA-w8hw-w9fx-j79w`;
const WMF = `${GHSA_BASE}/GHSA-6wmf-4rv5-p3rp`;
const LINK = "https://www.php.net/archive/2026.php#2026-10-21-5";
const TITLE = "Security advisory: Critical remote code execution vulnerabilities, update now";
const PUB = "2026-10-21T00:35:26Z";
const NOW = "2026-10-22T16:00:00Z";
const START = "2026-10-01T00:00:00Z";
const NO_FIX_SENTENCE = "<strong>PHP 8.1 and older</strong> no longer receive updates";
const PLACEHOLDER_ID = "tcs_00000000000000000000000000";
const RELEASED = parsePhpReleases(releasesXml);

const EXPECTED = [
  { cve: "CVE-2026-109618", ghsa: "GHSA-w8hw-w9fx-j79w", summary: "RCE via OOM corruption", json: ghsaW8hw },
  { cve: "CVE-2026-109619", ghsa: "GHSA-6wmf-4rv5-p3rp", summary: "RCE via stale global state", json: ghsa6wmf },
];

function routes(over: Record<string, FakeAnswer> = {}): Record<string, FakeAnswer> {
  return { [NEWS]: newsHtml, [RELEASES]: releasesXml, [W8HW]: ghsaW8hw, [WMF]: ghsa6wmf, ...over };
}

function ctxFor(fetchFn: typeof fetch, envOver: Partial<typeof env> = {}): IngestContext {
  return {
    env: { ...env, ...envOver },
    source: { id: "php-runtime", kind: "php-runtime", config: {} },
    now: () => new Date(NOW),
    fetch: fetchFn,
  };
}

function ghsaCalls(fake: { urls(): string[] }): string[] {
  return fake.urls().filter((u) => u.startsWith(`${GHSA_BASE}/`));
}

// The 2026-10-21 security entry of an (optionally edited) news page.
function securityEntry(html = newsHtml) {
  const e = parsePhpNews(html).find((x) => x.link === LINK);
  if (!e) throw new Error("no 2026-10-21 security entry");
  return e;
}

function normalizeOk(i: number, html = newsHtml): Advisory {
  const entry = securityEntry(html);
  const post = parsePhpPost(entry.content);
  const pair = post.pairs.find((p) => p.cve === EXPECTED[i].cve)!;
  const r = normalizePhpAdvisory(entry, pair, JSON.parse(EXPECTED[i].json), post.noFixLine, RELEASED);
  if (!r.ok) throw new Error(`normalize failed: ${r.reason}`);
  return { id: PLACEHOLDER_ID, ...r.doc };
}

async function phpRowCount(): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'php-runtime')",
  ).first<{ n: number }>();
  return r!.n;
}

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterAll(() => {
  // Every php.net and api.github.com read in this file goes through the fake: 0 real network calls.
  expect(fetchSpy).toHaveBeenCalledTimes(0);
  fetchSpy.mockRestore();
});

// Each test starts with no php-runtime rows and a cursor before the 2026-10-21 post.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = 'php-runtime')").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'php-runtime'").run();
  await env.CURSORS.put(PHP_CURSOR_KEY, START);
});

describe("php parsers (text)", () => {
  it("text: the recorded news page has the 2026-10-21 security entry with both CVE/GHSA pairs and the 8.1 no-fix line", () => {
    const entry = securityEntry();
    expect(entry.title).toBe(TITLE);
    expect(entry.published).toBe(PUB);
    const post = parsePhpPost(entry.content);
    expect(post.pairs).toEqual(EXPECTED.map((e) => ({ cve: e.cve, ghsa: e.ghsa })));
    expect(post.noFixLine).toBe("8.1");
  });

  it("text: the releases feed lists the four fixed versions", () => {
    for (const v of ["8.5.12", "8.4.27", "8.3.36", "8.2.35"]) expect(RELEASED.has(v)).toBe(true);
  });
});

describe("php-runtime seam (seam)", () => {
  it("seam: the GHSA request carries Accept, User-Agent and the API version, and no Authorization without a token", async () => {
    const fake = createRuntimeFake(routes());
    await fetchGhsa(fake.fetch, GHSA_BASE, "GHSA-w8hw-w9fx-j79w", undefined);
    const h = fake.calls[0].headers;
    expect(fake.calls[0].url).toBe(W8HW);
    expect(h["accept"]).toBe("application/vnd.github+json");
    expect(h["user-agent"]).toBe("tocsin.sh");
    expect(h["x-github-api-version"]).toBe("2022-11-28");
    expect(h["authorization"]).toBeUndefined();
  });

  it("seam: a GITHUB_TOKEN adds a bearer header", async () => {
    const fake = createRuntimeFake(routes());
    await fetchGhsa(fake.fetch, GHSA_BASE, "GHSA-w8hw-w9fx-j79w", "tok-fixture-1");
    expect(fake.calls[0].headers["authorization"]).toBe("Bearer tok-fixture-1");
  });

  it("seam: a 403 throws PhpHttpError with the status and URL", async () => {
    const fake = createRuntimeFake(routes({ [W8HW]: { status: 403 } }));
    const err = await fetchGhsa(fake.fetch, GHSA_BASE, "GHSA-w8hw-w9fx-j79w", undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhpHttpError);
    expect((err as PhpHttpError).status).toBe(403);
    expect((err as PhpHttpError).url).toBe(W8HW);
  });
});

describe("normalizePhpAdvisory (normalize)", () => {
  it.each([0, 1])("P1: advisory %i has the 4 fixed versions, score 9.2 critical, the 8.1 no-fix action", (i) => {
    const d = normalizeOk(i);
    for (const v of ["8.5.12", "8.4.27", "8.3.36", "8.2.35"]) expect(d.fixed_versions).toContain(v);
    expect(d.fixed_versions).toEqual(["8.2.35", "8.3.36", "8.4.27", "8.5.12"]);
    expect(d.severity).toEqual({ score: 9.2, label: "critical" });
    expect(d.action).toContain("8.1");
    expect(d.action).toContain("no fix");
    expect(d.action).toBe(
      "Upgrade php to 8.2.35 (8.2), 8.3.36 (8.3), 8.4.27 (8.4) or 8.5.12 (8.5) or later. Unsupported lines (8.1 and older) get no fix.",
    );
    expect(d.ghsa_id).toBe(EXPECTED[i].ghsa);
    expect(d.cve_ids).toEqual([EXPECTED[i].cve]);
    expect(d.affected).toHaveLength(4);
    expect(d.affected).toContainEqual({ introduced: "8.2.0", fixed: "8.2.35" });
    expect(d.summary).toBe(EXPECTED[i].summary);
    expect(d.ecosystem).toBe("php");
    expect(d.component).toBe("php");
    expect(d.sources).toEqual([{ source: "php-runtime", source_id: EXPECTED[i].cve, url: LINK }]);
    expect(d.references).toEqual([LINK, `https://github.com/php/php-src/security/advisories/${EXPECTED[i].ghsa}`]);
    const v = validateAdvisory(d);
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("normalize: a withdrawn or unpublished GHSA is an error, not a doc", () => {
    const entry = securityEntry();
    const g = JSON.parse(ghsaW8hw);
    g.state = "withdrawn";
    const r = normalizePhpAdvisory(entry, { cve: EXPECTED[0].cve, ghsa: EXPECTED[0].ghsa }, g, "8.1", RELEASED);
    expect(r.ok).toBe(false);
  });
});

describe("phpRuntime.run (run)", () => {
  it("P2: run stores 2 advisories with 1 news + 1 releases + 2 GHSA fetches and sets the cursor", async () => {
    const fake = createRuntimeFake(routes());
    const res = await phpRuntime.run(ctxFor(fake.fetch));
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(2);
    expect(fake.count(NEWS)).toBe(1);
    expect(fake.count(RELEASES)).toBe(1);
    expect(ghsaCalls(fake).sort()).toEqual([WMF, W8HW].sort());
    expect(fake.calls).toHaveLength(4);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(PUB);
    const row = await env.DB.prepare(
      "SELECT a.ecosystem, a.severity_label, a.severity_score FROM advisories a JOIN advisory_sources s ON s.advisory_id = a.id WHERE s.source = 'php-runtime' AND s.source_id = 'CVE-2026-109618'",
    ).first();
    expect(row).toEqual({ ecosystem: "php", severity_label: "critical", severity_score: 9.2 });
  });

  it("P3 re-run: unchanged for both, 0 GHSA calls, no new rows", async () => {
    await phpRuntime.run(ctxFor(createRuntimeFake(routes()).fetch));
    const before = await phpRowCount();
    const fake = createRuntimeFake(routes());
    const res = await phpRuntime.run(ctxFor(fake.fetch));
    expect(res.errors).toEqual([]);
    expect(res.unchanged).toBe(2);
    expect(res.upserted).toBe(0);
    expect(ghsaCalls(fake)).toEqual([]);
    expect(await phpRowCount()).toBe(before);
    expect(before).toBe(2);
  });

  it("P3b: the dedup read seeks the advisory_sources primary key at 2000 seeded rows (EXPLAIN QUERY PLAN)", async () => {
    const stmts = [];
    for (let i = 0; i < 2000; i++) {
      stmts.push(env.DB.prepare("INSERT INTO advisory_sources (source, source_id, advisory_id) VALUES (?, ?, ?)").bind("tcs6-explain", `CVE-2099-${10000 + i}`, `tcs6-explain-${i}`));
    }
    await env.DB.batch(stmts);
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${PHP_DEDUP_SQL}`).bind("php-runtime", "CVE-2026-109618").all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(" | ");
    expect(detail).toMatch(/SEARCH advisory_sources USING (COVERING )?INDEX sqlite_autoindex_advisory_sources_1 \(source=\? AND source_id=\?\)/);
    expect(detail).not.toMatch(/SCAN/);
    await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'tcs6-explain'").run();
  });

  it("P4: without the 'PHP 8.1 and older' sentence the action has no no-fix part (source: assumed, in-test edit)", async () => {
    expect(newsHtml).toContain(NO_FIX_SENTENCE);
    const edited = newsHtml.replace(NO_FIX_SENTENCE, "<strong>PHP 8.1 and older</strong> are covered by vendors");
    const res = await phpRuntime.run(ctxFor(createRuntimeFake(routes({ [NEWS]: edited })).fetch));
    expect(res.upserted).toBe(2);
    const row = await env.DB.prepare(
      "SELECT a.doc_json FROM advisories a JOIN advisory_sources s ON s.advisory_id = a.id WHERE s.source = 'php-runtime' AND s.source_id = 'CVE-2026-109619'",
    ).first<{ doc_json: string }>();
    const doc = JSON.parse(row!.doc_json) as Advisory;
    expect(doc.action).toBe("Upgrade php to 8.2.35 (8.2), 8.3.36 (8.3), 8.4.27 (8.4) or 8.5.12 (8.5) or later.");
    expect(doc.action).not.toContain("no fix");
  });

  it("P5: a fixed version absent from the releases feed stores nothing for the post, names it, and leaves the cursor (source: assumed, in-test edit)", async () => {
    const edited = releasesXml.replace("<php:version>8.3.36</php:version>", "");
    expect(edited).not.toBe(releasesXml);
    const res = await phpRuntime.run(ctxFor(createRuntimeFake(routes({ [RELEASES]: edited })).fetch));
    expect(res.upserted).toBe(0);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors.join("\n")).toContain("8.3.36");
    expect(await phpRowCount()).toBe(0);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(START);
  });

  it("P6: a GHSA 403 throws PhpHttpError and leaves the cursor", async () => {
    const fake = createRuntimeFake(routes({ [W8HW]: { status: 403, body: '{"message":"API rate limit exceeded"}' } }));
    await expect(phpRuntime.run(ctxFor(fake.fetch))).rejects.toBeInstanceOf(PhpHttpError);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(START);
  });

  it("P7: env GITHUB_TOKEN reaches the GHSA request as a bearer token; unset sends none", async () => {
    const withToken = createRuntimeFake(routes());
    await phpRuntime.run(ctxFor(withToken.fetch, { GITHUB_TOKEN: "tok-fixture-1" }));
    const ghsaWith = withToken.calls.filter((c) => c.url.startsWith(`${GHSA_BASE}/`));
    expect(ghsaWith).toHaveLength(2);
    for (const c of ghsaWith) expect(c.headers["authorization"]).toBe("Bearer tok-fixture-1");
    for (const c of withToken.calls.filter((c) => !c.url.startsWith(`${GHSA_BASE}/`))) expect(c.headers["authorization"]).toBeUndefined();

    await env.DB.prepare("DELETE FROM advisory_sources WHERE source = 'php-runtime'").run();
    await env.CURSORS.put(PHP_CURSOR_KEY, START);
    const without = createRuntimeFake(routes());
    await phpRuntime.run(ctxFor(without.fetch, { GITHUB_TOKEN: undefined }));
    const ghsaWithout = without.calls.filter((c) => c.url.startsWith(`${GHSA_BASE}/`));
    expect(ghsaWithout).toHaveLength(2);
    for (const c of ghsaWithout) expect(c.headers["authorization"]).toBeUndefined();
  });

  it.each(["PHP 8.5.12 Released!", "PHP 8.6.0 RC 3 available for testing", "PHP 8.5.12 release announcement scheduled"])(
    "P8: title %j makes 0 GHSA calls (source: assumed, in-test edit)",
    async (title) => {
      const edited = newsHtml.replace(`id="2026-10-21-5">${TITLE}</a>`, `id="2026-10-21-5">${title}</a>`);
      expect(edited).not.toBe(newsHtml);
      const fake = createRuntimeFake(routes({ [NEWS]: edited }));
      const res = await phpRuntime.run(ctxFor(fake.fetch));
      expect(ghsaCalls(fake)).toEqual([]);
      expect(fake.urls()).toEqual([NEWS]);
      expect(res.upserted).toBe(0);
    },
  );

  it("cursor: a cursor after the post skips it: 1 fetch (news only), 0 GHSA calls", async () => {
    await env.CURSORS.put(PHP_CURSOR_KEY, "2026-10-21T00:35:27Z");
    const fake = createRuntimeFake(routes());
    const res = await phpRuntime.run(ctxFor(fake.fetch));
    expect(fake.urls()).toEqual([NEWS]);
    expect(res.upserted + res.unchanged).toBe(0);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe("2026-10-21T00:35:27Z");
  });

  it("cursor: a cursor equal to the post date re-reads the post", async () => {
    await env.CURSORS.put(PHP_CURSOR_KEY, PUB);
    const fake = createRuntimeFake(routes());
    const res = await phpRuntime.run(ctxFor(fake.fetch));
    expect(res.upserted).toBe(2);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(PUB);
  });
});
