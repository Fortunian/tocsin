import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GithubLinkError } from "../../src/ingest/github-advisories";
import { fetchGhsaListPage, PhpHttpError } from "../../src/ingest/php-runtime-client";
import { normalizePhpAdvisory, parsePhpFixSentence, parsePhpNews, parsePhpReleases, PHP_CURSOR_KEY, phpRuntime } from "../../src/ingest/php-runtime";
import { runIngesters, type SourceOutcome } from "../../src/ingest/registry";
import type { IngestContext } from "../../src/ingest/types";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import newsHtml from "../fixtures/php-runtime/2026-10-21.html?raw";
import releasesXml from "../fixtures/php-runtime/releases.xml?raw";
import pageJson from "../fixtures/php-runtime/security-advisories.page1.json?raw";
import { createGhFake, type GhAnswer, type GhFake } from "./github-fake.tcs-41";

// Fixtures: the news page and releases feed are recorded; the list page is
// assembled from the two recorded GHSA answers plus one SYNTHETIC older item
// (tests/fixtures/php-runtime/README.md).
const SOURCE = "php-runtime";
const NEWS = "https://www.php.net/index.php";
const RELEASES = "https://www.php.net/releases/feed.php";
const GHSA_BASE = "https://api.github.com/repos/php/php-src/security-advisories";
const LIST = `${GHSA_BASE}?state=published&sort=published&direction=desc&per_page=3`;
const PAGE2 = `${LIST}&after=Y3Vyc29yOnYyOpK0`;
const LINK = "https://www.php.net/archive/2026.php#2026-10-21-5";
const TITLE = "Security advisory: Critical remote code execution vulnerabilities, update now";
const NOW = "2026-10-23T02:00:00Z";
// Between Y (2026-10-21T13:34:13Z) and Z (2026-09-15T00:00:00Z).
const START = "2026-10-01T00:00:00Z";
const X = { ghsa: "GHSA-w8hw-w9fx-j79w", cve: "CVE-2026-109618", published: "2026-10-21T13:34:25Z" };
const Y = { ghsa: "GHSA-6wmf-4rv5-p3rp", cve: "CVE-2026-109619", published: "2026-10-21T13:34:13Z" };
const Z = { ghsa: "GHSA-2222-2222-2222", cve: "CVE-2099-10001" };
const FIXED = ["8.2.35", "8.3.36", "8.4.27", "8.5.12"];
const RELEASED = parsePhpReleases(releasesXml);

type Item = Record<string, unknown> & { ghsa_id: string; vulnerabilities: Record<string, unknown>[] };
const items = (): Item[] => JSON.parse(pageJson) as Item[];

// The page with Y's patched_versions removed (source: assumed, in-test edit).
function pageYUnpatched(): Item[] {
  const page = items();
  const y = page.find((i) => i.ghsa_id === Y.ghsa)!;
  for (const v of y.vulnerabilities) delete v.patched_versions;
  return page;
}

const json = (v: unknown) => JSON.stringify(v);

let realCalls = 0;
const throwing = async (input: unknown) => {
  realCalls += 1;
  throw new Error(`real network call in a php-runtime test: ${String(input)}`);
};
let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(throwing as never);
});
afterAll(() => {
  // Every php.net and api.github.com read in this file goes through the fake: 0 real network calls.
  expect(realCalls).toBe(0);
  fetchSpy.mockRestore();
});

function routes(over: Record<string, string | GhAnswer> = {}): Record<string, string | GhAnswer> {
  return { [LIST]: json(pageYUnpatched()), [NEWS]: newsHtml, [RELEASES]: releasesXml, ...over };
}

function ctxFor(fake: GhFake, config: Record<string, unknown> = { page_size: 3 }, envOver: Partial<typeof env> = {}): IngestContext {
  return {
    env: { ...env, ...envOver },
    source: { id: SOURCE, kind: SOURCE, config },
    now: () => new Date(NOW),
    fetch: fake.fetch,
  };
}

const perGhsaCalls = (fake: GhFake) => fake.urls().filter((u) => u.startsWith(`${GHSA_BASE}/`));

async function phpDocs(): Promise<Map<string, Advisory>> {
  const { results } = await env.DB.prepare(
    "SELECT s.source_id, a.doc_json FROM advisories a JOIN advisory_sources s ON s.advisory_id = a.id WHERE s.source = ? ORDER BY s.source_id",
  )
    .bind(SOURCE)
    .all<{ source_id: string; doc_json: string }>();
  return new Map(results.map((r) => [r.source_id, JSON.parse(r.doc_json) as Advisory]));
}

// Only php-runtime is enabled; runIngesters runs it and writes the sources row (D2).
async function runThroughRegistry(fake: GhFake, config: Record<string, unknown>): Promise<SourceOutcome> {
  await env.DB.prepare("UPDATE sources SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END, config_json = CASE WHEN id = ? THEN ? ELSE config_json END")
    .bind(SOURCE, SOURCE, JSON.stringify(config))
    .run();
  fetchSpy.mockImplementation(fake.fetch as never);
  try {
    const outcomes = await runIngesters(env, { [SOURCE]: phpRuntime }, () => new Date(NOW));
    expect(outcomes.map((o) => o.source)).toEqual([SOURCE]);
    return outcomes[0];
  } finally {
    fetchSpy.mockImplementation(throwing as never);
    await env.DB.prepare("UPDATE sources SET enabled = 1, config_json = CASE WHEN id = ? THEN '{}' ELSE config_json END").bind(SOURCE).run();
  }
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = ?)").bind(SOURCE).run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = ?").bind(SOURCE).run();
  await env.DB.prepare("UPDATE sources SET last_error = NULL, last_ok_at = NULL WHERE id = ?").bind(SOURCE).run();
  await env.CURSORS.put(PHP_CURSOR_KEY, START);
});

describe("php list seam (seam)", () => {
  it("seam: the list request carries the GitHub headers, no Authorization without a token, and returns the array", async () => {
    const fake = createGhFake({ [LIST]: pageJson });
    const page = await fetchGhsaListPage(fake.fetch, LIST, undefined, "https://api.github.com");
    expect(page.body).toHaveLength(3);
    expect(page.next).toBeUndefined();
    const h = fake.calls[0].headers;
    expect(fake.calls[0].url).toBe(LIST);
    expect(h["accept"]).toBe("application/vnd.github+json");
    expect(h["user-agent"]).toBe("tocsin.sh");
    expect(h["x-github-api-version"]).toBe("2022-11-28");
    expect(h["authorization"]).toBeUndefined();
  });

  it("seam: a token adds a bearer header and a Link next on the same origin is returned", async () => {
    const fake = createGhFake({ [LIST]: { body: pageJson, next: PAGE2 } });
    const page = await fetchGhsaListPage(fake.fetch, LIST, "tok-fixture-29", "https://api.github.com");
    expect(fake.calls[0].headers["authorization"]).toBe("Bearer tok-fixture-29");
    expect(page.next).toBe(PAGE2);
  });

  it("seam: a 403 throws PhpHttpError whose message carries the status, the URL and the body", async () => {
    const body = '{"message":"API rate limit exceeded for 1.2.3.4."}';
    const fake = createGhFake({ [LIST]: { status: 403, body } });
    const err = await fetchGhsaListPage(fake.fetch, LIST, undefined, "https://api.github.com").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhpHttpError);
    expect((err as PhpHttpError).status).toBe(403);
    expect((err as PhpHttpError).url).toBe(LIST);
    expect((err as PhpHttpError).message).toBe(`PHP source HTTP 403 for ${LIST}: ${body}`);
  });

  it("seam: an answer that is not a JSON array throws", async () => {
    const fake = createGhFake({ [LIST]: '{"message":"Not Found"}' });
    await expect(fetchGhsaListPage(fake.fetch, LIST, undefined, "https://api.github.com")).rejects.toThrow(/not a JSON array/);
  });
});

describe("php fix sentence and normalize fallback (sentence, normalize)", () => {
  const post = () => parsePhpNews(newsHtml).find((e) => e.link === LINK)!;

  it("A8 sentence: the recorded post gives the 4 versions in source order", () => {
    expect(post().title).toBe(TITLE);
    expect(parsePhpFixSentence(post().content)).toEqual(["8.5.12", "8.4.27", "8.3.36", "8.2.35"]);
  });

  it.each([
    "<h2>PHP 8.5.12 Released!</h2>",
    "<p>Update to PHP 8.6.0RC3 for testing.</p>",
    "<p>Please update your PHP install.</p>",
    "<p>PHP 8.5.12 is out. Read the changelog.</p>",
  ])("A8 sentence: %j gives no versions", (html) => {
    expect(parsePhpFixSentence(html)).toEqual([]);
  });

  it("normalize: with no news entry, the GHSA html_url is the source and the reference", () => {
    const x = items().find((i) => i.ghsa_id === X.ghsa)!;
    const r = normalizePhpAdvisory(undefined, { cve: X.cve, ghsa: X.ghsa }, x, undefined, RELEASED);
    if (!r.ok) throw new Error(r.reason);
    const html = `https://github.com/php/php-src/security/advisories/${X.ghsa}`;
    expect(r.doc.sources).toEqual([{ source: SOURCE, source_id: X.cve, url: html }]);
    expect(r.doc.references).toEqual([html]);
    expect(r.doc.published_at).toBe(X.published);
    expect(r.doc.fixed_versions).toEqual(FIXED);
    expect(r.doc.action).not.toContain("no fix");
    const v = validateAdvisory({ id: "tcs_00000000000000000000000000", ...r.doc });
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("normalize: no patched_versions uses the fallback fixed versions, each line from <line>.0", () => {
    const y = pageYUnpatched().find((i) => i.ghsa_id === Y.ghsa)!;
    const r = normalizePhpAdvisory(undefined, { cve: Y.cve, ghsa: Y.ghsa }, y, undefined, RELEASED, ["8.5.12", "8.4.27", "8.3.36", "8.2.35"]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.doc.fixed_versions).toEqual(FIXED);
    expect(r.doc.affected).toEqual(FIXED.map((f) => ({ introduced: `${f.split(".").slice(0, 2).join(".")}.0`, fixed: f })));
  });

  it("normalize: no patched_versions and no fallback is an incomplete error", () => {
    const y = pageYUnpatched().find((i) => i.ghsa_id === Y.ghsa)!;
    const r = normalizePhpAdvisory(undefined, { cve: Y.cve, ghsa: Y.ghsa }, y, undefined, RELEASED, []);
    expect(r).toEqual({ ok: false, reason: `${Y.cve} (${Y.ghsa}): GHSA has no patched version`, incomplete: true });
  });
});

describe("phpRuntime.run over the advisories list (run)", () => {
  it("A1: stores X (patched_versions) and Y (fix sentence), does not read Z, and moves the cursor", async () => {
    const fake = createGhFake(routes());
    const res = await phpRuntime.run(ctxFor(fake));
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(2);
    expect(res.fetched).toBe(2);
    const docs = await phpDocs();
    expect([...docs.keys()]).toEqual([X.cve, Y.cve]);
    const x = docs.get(X.cve)!;
    expect(x.fixed_versions).toEqual(FIXED);
    expect(x.affected).toEqual([
      { introduced: "0", fixed: "8.2.35" },
      { introduced: "8.3.0", fixed: "8.3.36" },
      { introduced: "8.4.0", fixed: "8.4.27" },
      { introduced: "8.5.0", fixed: "8.5.12" },
    ]);
    const y = docs.get(Y.cve)!;
    expect(y.fixed_versions).toEqual(FIXED);
    expect(y.affected).toEqual([
      { introduced: "8.2.0", fixed: "8.2.35" },
      { introduced: "8.3.0", fixed: "8.3.36" },
      { introduced: "8.4.0", fixed: "8.4.27" },
      { introduced: "8.5.0", fixed: "8.5.12" },
    ]);
    // The post links both: its link is the source, and its no-fix sentence is the tail.
    expect(y.sources).toEqual([{ source: SOURCE, source_id: Y.cve, url: LINK }]);
    expect(y.action).toContain("Unsupported lines (8.1 and older) get no fix.");
    const z = await env.DB.prepare("SELECT 1 AS hit FROM advisory_sources WHERE source = ? AND source_id = ?").bind(SOURCE, Z.cve).first();
    expect(z).toBeNull();
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(X.published);
    expect(fake.count(LIST)).toBe(1);
    expect(fake.count(NEWS)).toBe(1);
    expect(fake.count(RELEASES)).toBe(1);
    expect(perGhsaCalls(fake)).toEqual([]);
    expect(fake.calls).toHaveLength(3);
  });

  it("A2: a second run gives unchanged for both, the same rows, and 0 news and releases reads", async () => {
    await phpRuntime.run(ctxFor(createGhFake(routes())));
    await env.CURSORS.put(PHP_CURSOR_KEY, START);
    const fake = createGhFake(routes());
    const res = await phpRuntime.run(ctxFor(fake));
    expect(res.errors).toEqual([]);
    expect(res.unchanged).toBe(2);
    expect(res.upserted).toBe(0);
    expect((await phpDocs()).size).toBe(2);
    expect(fake.urls()).toEqual([LIST]);
  });

  it("A3: a 403 rate-limit answer marks the source failed with the body, stores nothing, and keeps the cursor", async () => {
    const body = '{"message":"API rate limit exceeded for 1.2.3.4. (Authenticated requests get a higher rate limit.)","documentation_url":"https://docs.github.com/rest/rate-limit"}';
    const fake = createGhFake({ [LIST]: { status: 403, body } });
    const out = await runThroughRegistry(fake, { page_size: 3 });
    expect(out.status).toBe("failed");
    const row = await env.DB.prepare("SELECT last_error FROM sources WHERE id = ?").bind(SOURCE).first<{ last_error: string }>();
    expect(row!.last_error).toContain(body);
    expect(row!.last_error.length).toBeLessThanOrEqual(1000);
    expect((await phpDocs()).size).toBe(0);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(START);
    expect(fake.urls()).toEqual([LIST]);
  });

  it("A3: a 1500-char 403 body is cut: last_error holds its first 500 chars and is at most 1000 chars", async () => {
    const body = `{"message":"API rate limit exceeded ${"x".repeat(1500)}`.slice(0, 1500);
    const out = await runThroughRegistry(createGhFake({ [LIST]: { status: 403, body } }), { page_size: 3 });
    expect(out.status).toBe("failed");
    const row = await env.DB.prepare("SELECT last_error FROM sources WHERE id = ?").bind(SOURCE).first<{ last_error: string }>();
    expect(row!.last_error).toContain(body.slice(0, 500));
    expect(row!.last_error.length).toBeLessThanOrEqual(1000);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(START);
  });

  it("A4: more advisories newer than the cursor than max_advisories throws, stores nothing, and keeps the cursor", async () => {
    const fake = createGhFake(routes());
    await expect(phpRuntime.run(ctxFor(fake, { page_size: 3, max_advisories: 1 }))).rejects.toThrow(/max_advisories/);
    expect((await phpDocs()).size).toBe(0);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(START);
  });

  it("A5: a Link next page is read in order; both advisories are stored", async () => {
    const page = pageYUnpatched();
    const fake = createGhFake(routes({ [LIST]: { body: json(page.slice(0, 1)), next: PAGE2 }, [PAGE2]: json(page.slice(1)) }));
    const res = await phpRuntime.run(ctxFor(fake));
    expect(res.errors).toEqual([]);
    expect(res.upserted).toBe(2);
    expect(fake.urls().filter((u) => u.startsWith(GHSA_BASE))).toEqual([LIST, PAGE2]);
  });

  it("A5: a Link next on another origin throws GithubLinkError and is not read", async () => {
    const fake = createGhFake(routes({ [LIST]: { body: json(pageYUnpatched().slice(0, 1)), next: "https://evil.example/advisories?page=2" } }));
    await expect(phpRuntime.run(ctxFor(fake))).rejects.toBeInstanceOf(GithubLinkError);
    expect(fake.urls().filter((u) => u.startsWith("https://evil.example"))).toEqual([]);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(START);
  });

  it("A6: GITHUB_TOKEN reaches only the list request as a bearer; unset sends no Authorization", async () => {
    const withToken = createGhFake(routes());
    await phpRuntime.run(ctxFor(withToken, { page_size: 3 }, { GITHUB_TOKEN: "tok-fixture-29" }));
    expect(withToken.calls.find((c) => c.url === LIST)!.headers["authorization"]).toBe("Bearer tok-fixture-29");
    const others = withToken.calls.filter((c) => c.url !== LIST);
    expect(others.map((c) => c.url).sort()).toEqual([NEWS, RELEASES].sort());
    for (const c of others) expect(c.headers["authorization"]).toBeUndefined();

    await env.DB.prepare("DELETE FROM advisory_sources WHERE source = ?").bind(SOURCE).run();
    await env.CURSORS.put(PHP_CURSOR_KEY, START);
    const without = createGhFake(routes());
    await phpRuntime.run(ctxFor(without, { page_size: 3 }, { GITHUB_TOKEN: undefined }));
    expect(without.calls).toHaveLength(3);
    for (const c of without.calls) expect(c.headers["authorization"]).toBeUndefined();
  });

  it("A7: Y with no patched_versions and no linking post is an error; X is stored; the cursor holds until the post is there", async () => {
    // The post title no longer matches title_match, so no post is used (source: assumed, in-test edit).
    const edited = newsHtml.replace(`id="2026-10-21-5">${TITLE}</a>`, `id="2026-10-21-5">PHP 8.5.12 Released!</a>`);
    expect(edited).not.toBe(newsHtml);
    const first = await phpRuntime.run(ctxFor(createGhFake(routes({ [NEWS]: edited }))));
    expect(first.upserted).toBe(1);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toContain(Y.ghsa);
    expect([...(await phpDocs()).keys()]).toEqual([X.cve]);
    expect((await phpDocs()).get(X.cve)!.sources[0].url).toBe(`https://github.com/php/php-src/security/advisories/${X.ghsa}`);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(START);

    const second = await phpRuntime.run(ctxFor(createGhFake(routes())));
    expect(second.errors).toEqual([]);
    expect(second.upserted).toBe(1);
    expect(second.unchanged).toBe(1);
    expect([...(await phpDocs()).keys()]).toEqual([X.cve, Y.cve]);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(X.published);
  });

  it("A9: an advisory with no CVE id is an error, is not stored, and the cursor holds", async () => {
    const page = items();
    page.find((i) => i.ghsa_id === Y.ghsa)!.cve_id = null;
    const res = await phpRuntime.run(ctxFor(createGhFake(routes({ [LIST]: json(page) }))));
    expect(res.errors).toEqual([`${Y.ghsa}: no CVE id yet`]);
    expect([...(await phpDocs()).keys()]).toEqual([X.cve]);
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe(START);
  });
});
