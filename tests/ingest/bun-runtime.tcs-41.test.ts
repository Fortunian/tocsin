import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { BUN_DEFAULTS } from "../../src/ingest/bun-runtime";
import { cursorKey, etagKey, parseReleaseTags } from "../../src/ingest/github-runtime";
import { defaultRegistry, runIngesters, type SourceOutcome } from "../../src/ingest/registry";
import type { RunResult } from "../../src/ingest/types";
import type { Advisory } from "../../src/schema/advisory";
import emptyJson from "../fixtures/bun-runtime/advisories-empty.json?raw";
import syntheticJson from "../fixtures/bun-runtime/advisories-synthetic.json?raw";
import releasesJson from "../fixtures/bun-runtime/releases.json?raw";
import { get } from "../routes/seed.tcs-3";
import { createGhFake, type GhAnswer, type GhFake } from "./github-fake.tcs-41";

// advisories-empty.json is the real answer (Bun had 0 advisories on 2026-10-23);
// advisories-synthetic.json is ONE SYNTHETIC entry (tests/fixtures/bun-runtime/README.md).
const SOURCE = "bun-runtime";
const FIRST = "https://api.github.com/repos/oven-sh/bun/security-advisories?state=published&sort=published&direction=desc&per_page=100";
const RELEASES = "https://api.github.com/repos/oven-sh/bun/releases?per_page=100";
const ETAG_EMPTY = '"bun-empty-fixture-etag"';
const ETAG_SYN = '"bun-synthetic-fixture-etag"';
const GHSA = "GHSA-6666-7777-8888";
const URL_GHSA = `https://github.com/oven-sh/bun/security/advisories/${GHSA}`;
const NOW = new Date("2026-10-23T01:00:00Z");

const throwing = (input: unknown) => {
  throw new Error(`real network call in a bun-runtime test: ${String(input)}`);
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

async function runBun(): Promise<SourceOutcome> {
  await env.DB.prepare("UPDATE sources SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END").bind(SOURCE).run();
  try {
    const outcomes = await runIngesters(env, defaultRegistry, () => NOW);
    expect(outcomes.map((o) => o.source)).toEqual([SOURCE]);
    return outcomes[0];
  } finally {
    await env.DB.prepare("UPDATE sources SET enabled = 1").run();
  }
}

function resultOf(o: SourceOutcome): RunResult {
  if (o.status !== "ok") throw new Error(`bun-runtime did not run ok: ${JSON.stringify(o)}`);
  return o.result;
}

async function bunDoc(): Promise<(Advisory & { col_ecosystem: string; col_component: string }) | null> {
  const row = await env.DB.prepare(
    "SELECT a.doc_json, a.ecosystem, a.component FROM advisories a JOIN advisory_sources s ON s.advisory_id = a.id WHERE s.source = ? AND s.source_id = ?",
  )
    .bind(SOURCE, GHSA)
    .first<{ doc_json: string; ecosystem: string; component: string }>();
  return row ? { ...(JSON.parse(row.doc_json) as Advisory), col_ecosystem: row.ecosystem, col_component: row.component } : null;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source = ?)").bind(SOURCE).run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source = ?").bind(SOURCE).run();
  await env.CURSORS.delete(cursorKey(SOURCE));
  await env.CURSORS.delete(etagKey(SOURCE));
  // TCS-32: a source with no coverage_since reads its whole history once
  // (tests/ingest/github-runtime-coverage.tcs-32.test.ts). These tests pin the
  // cursor and ETag rules of a covered source, so each one starts covered.
  await env.DB.prepare("UPDATE sources SET coverage_since = '2020-01-01T00:00:00Z' WHERE id = ?").bind(SOURCE).run();
  fetchSpy.mockImplementation(throwing as never);
});

type Body = { affected: { url: string; fixed_in: string | null }[] };

describe("bun-runtime", () => {
  it("the real empty page: run ok, 0 upserted, ETag stored, no cursor, last_ok_at set", async () => {
    useFake({ [FIRST]: { body: emptyJson, etag: ETAG_EMPTY } });
    const r = resultOf(await runBun());
    expect(r).toMatchObject({ fetched: 0, upserted: 0, unchanged: 0, errors: [] });
    expect(await env.CURSORS.get(etagKey(SOURCE))).toBe(ETAG_EMPTY);
    expect(await env.CURSORS.get(cursorKey(SOURCE))).toBeNull();
    const row = await env.DB.prepare("SELECT kind, enabled, last_ok_at, last_error FROM sources WHERE id = ?").bind(SOURCE).first();
    expect(row).toEqual({ kind: "bun-runtime", enabled: 1, last_ok_at: NOW.toISOString(), last_error: null });
    expect(fake.urls()).toEqual([FIRST]);
  });

  it("synthetic page: one bun/bun doc with fixed_in the patched version", async () => {
    useFake({ [FIRST]: { body: syntheticJson, etag: ETAG_SYN } });
    const r = resultOf(await runBun());
    expect(r).toMatchObject({ fetched: 1, upserted: 1, errors: [] });
    const d = await bunDoc();
    expect(d).toMatchObject({ col_ecosystem: "bun", col_component: "bun", ecosystem: "bun", component: "bun", fixed_versions: ["1.1.31"], ghsa_id: GHSA });
    expect(d!.affected).toEqual([{ introduced: "0", fixed: "1.1.31" }]);
    expect(d!.action).toBe("Upgrade bun to 1.1.31 or later.");
    expect(d!.sources).toEqual([{ source: SOURCE, source_id: GHSA, url: URL_GHSA }]);
    expect(await env.CURSORS.get(cursorKey(SOURCE))).toBe("2026-10-15T12:00:00Z");
  });

  it("second run (200, no ETag match): unchanged, no new row", async () => {
    useFake({ [FIRST]: syntheticJson });
    await runBun();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(cursor) AS m FROM advisories").first();
    useFake({ [FIRST]: syntheticJson });
    const r = resultOf(await runBun());
    expect(r).toMatchObject({ fetched: 1, upserted: 0, unchanged: 1, errors: [] });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n, MAX(cursor) AS m FROM advisories").first()).toEqual(before);
  });

  it("check: bun=1.1.30 lists the synthetic advisory with fixed_in 1.1.31; bun=1.1.31 does not", async () => {
    useFake({ [FIRST]: syntheticJson });
    await runBun();
    const hit = (await (await get("/v1/check?deno=2.1.0&bun=1.1.30", "192.0.2.221")).json()) as Body;
    expect(hit.affected.find((a) => a.url === URL_GHSA)).toMatchObject({ fixed_in: "1.1.31" });
    const patched = (await (await get("/v1/check?bun=1.1.31", "192.0.2.222")).json()) as Body;
    expect(patched.affected.map((a) => a.url)).not.toContain(URL_GHSA);
  });

  it("the bun-v tag prefix parses release tags; drafts, prereleases and other tags are dropped", () => {
    expect(BUN_DEFAULTS.release_tag_prefix).toBe("bun-v");
    expect(parseReleaseTags(JSON.parse(releasesJson), "bun-v")).toEqual(["1.1.31", "1.1.30"]);
    // A prerelease or a draft with a release-shaped tag is still dropped.
    const shaped = [
      { tag_name: "bun-v1.1.33", draft: false, prerelease: true },
      { tag_name: "bun-v1.1.34", draft: true, prerelease: false },
      { tag_name: "bun-v1.1.35", draft: false, prerelease: false },
    ];
    expect(parseReleaseTags(shaped, "bun-v")).toEqual(["1.1.35"]);
  });

  it("an empty patched_versions takes the fix from the bun-v release tags", async () => {
    const entries = JSON.parse(syntheticJson);
    entries[0].vulnerabilities[0].patched_versions = "";
    entries[0].vulnerabilities[0].vulnerable_version_range = "< 1.1.31";
    useFake({ [FIRST]: JSON.stringify(entries), [RELEASES]: releasesJson });
    const r = resultOf(await runBun());
    expect(r).toMatchObject({ upserted: 1, errors: [] });
    expect(fake.urls()).toEqual([FIRST, RELEASES]);
    expect((await bunDoc())!.fixed_versions).toEqual(["1.1.31"]);
  });
});
