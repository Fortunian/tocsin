import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DEFAULT_ECOSYSTEMS, normalizeOsv, osv, type OsvVuln } from "../../src/ingest/osv";
import type { IngestContext } from "../../src/ingest/types";
import { upsertAdvisory } from "../../src/ingest/upsert";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import multi from "../fixtures/osv/multi-package.tcs-46.json";
import page1 from "../fixtures/osv/page1.json";
import { get } from "../routes/seed.tcs-3";
import { createOsvFake, FAKE_API_BASE, FAKE_CSV_BASE, type FakeRecord } from "./osv-fake";

// TCS-46: an OSV record with several affected packages stores one advisory per
// enabled (ecosystem, name). The first keeps source_id <OSV id>; later ones
// use <OSV id>#<ecosystem>/<name>.
//
// multi-package.tcs-46.json, source: assumed. api.osv.dev was not reachable
// from the build box, so the 2 records are hand-written from the shape probed
// on 2026-10-22. GHSA-jpcq-cgw6-v4j6 is trimmed from 5 to 3 affected[] entries:
// npm/jquery, RubyGems/jquery-rails and NuGet/jQuery (NuGet is not enabled).
//
// Each test uses its own record id (suffix -tcs46<tag>) and its own CVE alias,
// so tests never share rows. Every request sends its own client IP.

const CURSOR_KEY = "cursor:osv";
const GHSA_ID = "GHSA-jpcq-cgw6-v4j6";

function ghsa(tag: string, cve: string): OsvVuln {
  const r = structuredClone((multi as unknown as OsvVuln[]).find((x) => x.id === GHSA_ID)!);
  r.id = `${GHSA_ID}-tcs46${tag}`;
  r.aliases = [cve];
  return r;
}

const keys = (id: string) => [id, `${id}#RubyGems/jquery-rails`];

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterAll(() => {
  // Every OSV read in this file goes through the fake: 0 real network calls.
  expect(fetchSpy).toHaveBeenCalledTimes(0);
  fetchSpy.mockRestore();
});

function ctxFor(records: OsvVuln[]): IngestContext {
  return {
    env,
    source: { id: "osv", kind: "osv", config: { csv_base: FAKE_CSV_BASE, api_base: FAKE_API_BASE } },
    now: () => new Date("2026-10-22T00:00:00Z"),
    fetch: createOsvFake(records as unknown as FakeRecord[]).fetch,
  };
}

async function advisoryIds(sourceIds: string[]): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT source_id, advisory_id FROM advisory_sources WHERE source = 'osv' AND source_id IN (${sourceIds.map(() => "?").join(",")})`,
  )
    .bind(...sourceIds)
    .all<{ source_id: string; advisory_id: string }>();
  return Object.fromEntries(results.map((r) => [r.source_id, r.advisory_id]));
}

// Runs the production ingester over one record and returns the advisory ids of its two packages.
async function ingest(v: OsvVuln): Promise<[string, string]> {
  const res = await osv.run(ctxFor([v]));
  expect(res.errors).toEqual([]);
  const ids = await advisoryIds(keys(v.id));
  const pair: [string, string] = [ids[keys(v.id)[0]], ids[keys(v.id)[1]]];
  expect(pair[0]).toBeTruthy();
  expect(pair[1]).toBeTruthy();
  return pair;
}

beforeEach(async () => {
  await env.CURSORS.put(CURSOR_KEY, "2000-01-01T00:00:00Z");
});

describe("normalizeOsv with several affected packages (normalize)", () => {
  it("normalize: two docs with the right components and ranges; NuGet entry yields no doc", () => {
    const v = ghsa("", "CVE-2020-11023");
    const r = normalizeOsv(v, DEFAULT_ECOSYSTEMS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docs.map((d) => [d.doc.ecosystem, d.doc.component])).toEqual([
      ["npm", "jquery"],
      ["RubyGems", "jquery-rails"],
    ]);
    expect(r.docs.map((d) => d.source_id)).toEqual(["GHSA-jpcq-cgw6-v4j6-tcs46", "GHSA-jpcq-cgw6-v4j6-tcs46#RubyGems/jquery-rails"]);
    expect(r.doc).toBe(r.docs[0].doc);

    const [npm, gem] = r.docs.map((d) => d.doc);
    expect(npm.affected).toEqual([{ introduced: "1.0.3", fixed: "3.5.0" }]);
    expect(npm.fixed_versions).toEqual(["3.5.0"]);
    expect(npm.action).toBe("Upgrade jquery to 3.5.0 or later.");
    expect(gem.affected).toEqual([{ introduced: "0", fixed: "4.4.0" }]);
    expect(gem.fixed_versions).toEqual(["4.4.0"]);
    expect(gem.action).toBe("Upgrade jquery-rails to 4.4.0 or later.");

    // Each doc names its own key as creator; the link stays the real OSV page.
    for (const d of r.docs) {
      expect(d.doc.sources).toEqual([{ source: "osv", source_id: d.source_id, url: `https://osv.dev/vulnerability/${v.id}` }]);
      expect(d.doc.cve_ids).toEqual(["CVE-2020-11023"]);
      expect(d.doc.severity).toEqual({ score: 6.1, label: "medium" });
      const valid = validateAdvisory({ ...d.doc, id: "tcs_00000000000000000000000000" });
      expect(valid.ok ? [] : valid.errors).toEqual([]);
    }
    expect(r.docs.some((d) => d.doc.component === "jQuery")).toBe(false);
  });

  it("normalize negatives: a duplicate entry, an empty name and a single-package record", () => {
    const dup = ghsa("", "CVE-2020-11023");
    dup.affected!.push(
      { package: { ecosystem: "npm", name: "jquery" }, ranges: [{ type: "SEMVER", events: [{ introduced: "4.0.0" }, { fixed: "4.0.1" }] }] },
      { package: { ecosystem: "npm", name: "" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] },
    );
    const r = normalizeOsv(dup, DEFAULT_ECOSYSTEMS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docs.map((d) => d.doc.component)).toEqual(["jquery", "jquery-rails"]);
    // The duplicate entry's ranges join the one npm/jquery doc.
    expect(r.docs[0].doc.affected).toEqual([
      { introduced: "1.0.3", fixed: "3.5.0" },
      { introduced: "4.0.0", fixed: "4.0.1" },
    ]);

    const single = structuredClone((page1 as unknown as OsvVuln[]).find((x) => x.id === "GO-2020-0001")!);
    const s = normalizeOsv(single, DEFAULT_ECOSYSTEMS);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.docs.map((d) => d.source_id)).toEqual(["GO-2020-0001"]);

    const none = normalizeOsv(ghsa("", "CVE-2020-11023"), ["NuGet-not-listed"]);
    expect(none).toEqual({ ok: false, reason: "no affected package in a listed ecosystem" });
  });
});

describe("osv ingester stores every package (run)", () => {
  it("run: the first run stores 2 rows under 2 source ids", async () => {
    const v = ghsa("r", "CVE-2020-1102361");
    const res = await osv.run(ctxFor([v]));
    expect(res).toEqual({ fetched: 1, upserted: 2, unchanged: 0, errors: [] });
    const ids = await advisoryIds(keys(v.id));
    expect(Object.keys(ids).sort()).toEqual(keys(v.id).sort());
    expect(new Set(Object.values(ids)).size).toBe(2);

    const { results } = await env.DB.prepare(
      `SELECT ecosystem, component FROM advisories WHERE id IN (?, ?) ORDER BY component`,
    )
      .bind(...Object.values(ids))
      .all<{ ecosystem: string; component: string }>();
    expect(results).toEqual([
      { ecosystem: "npm", component: "jquery" },
      { ecosystem: "RubyGems", component: "jquery-rails" },
    ]);
  });

  it("run: a second run is unchanged twice", async () => {
    const v = ghsa("u", "CVE-2020-1102362");
    expect((await osv.run(ctxFor([v]))).upserted).toBe(2);
    await env.CURSORS.put(CURSOR_KEY, "2000-01-01T00:00:00Z");
    expect(await osv.run(ctxFor([v]))).toEqual({ fetched: 1, upserted: 0, unchanged: 2, errors: [] });
  });

  it("run: a re-read of a pre-change row adds the missing row and leaves the first unchanged", async () => {
    const v = ghsa("p", "CVE-2020-1102363");
    // Before TCS-46 a run stored only the first package, under <OSV id>.
    const r = normalizeOsv(v, DEFAULT_ECOSYSTEMS);
    if (!r.ok) throw new Error(r.reason);
    await upsertAdvisory(env.DB, r.doc, { source: "osv", source_id: v.id });
    const before = await advisoryIds([v.id]);

    expect(await osv.run(ctxFor([v]))).toEqual({ fetched: 1, upserted: 1, unchanged: 1, errors: [] });
    const after = await advisoryIds(keys(v.id));
    expect(after[v.id]).toBe(before[v.id]);
    expect(after[`${v.id}#RubyGems/jquery-rails`]).toBeTruthy();
    expect(after[`${v.id}#RubyGems/jquery-rails`]).not.toBe(before[v.id]);
  });
});

describe("each package is its own advisory on every read path", () => {
  it("feed: two events, distinct cursors", async () => {
    const [a, b] = await ingest(ghsa("f", "CVE-2020-1102364"));
    const res = await get("/v1/events?component=jquery,jquery-rails&limit=100&order=desc", "192.0.2.146");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Advisory[] };
    const ours = body.events.filter((e) => e.id === a || e.id === b);
    expect(ours.map((e) => e.component).sort()).toEqual(["jquery", "jquery-rails"]);
    const cursors = await env.DB.prepare("SELECT cursor FROM advisories WHERE id IN (?, ?)").bind(a, b).all<{ cursor: number }>();
    expect(new Set(cursors.results.map((x) => x.cursor)).size).toBe(2);
  });

  it("GET /cve/CVE-2020-11023 lists both", async () => {
    const [a, b] = await ingest(ghsa("c", "CVE-2020-11023"));
    const res = await get("/cve/CVE-2020-11023", "192.0.2.147", { Accept: "application/json" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cve: string; advisories: Advisory[] };
    expect(body.advisories.map((d) => d.id).sort()).toEqual([a, b].sort());
    expect(body.advisories.map((d) => d.component).sort()).toEqual(["jquery", "jquery-rails"]);
  });

  it("POST /v1/check jquery-rails is affected", async () => {
    const [, gemId] = await ingest(ghsa("k", "CVE-2020-1102365"));
    const check = (version: string, ip: string) =>
      exports.default.fetch("https://tocsin.test/v1/check", {
        method: "POST",
        headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
        body: JSON.stringify({ dependencies: [{ ecosystem: "RubyGems", name: "jquery-rails", version }] }),
      });
    const res = await check("4.0.5", "192.0.2.148");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected: { advisory_id: string; fixed_in: string | null }[] };
    expect(body.affected).toContainEqual(expect.objectContaining({ advisory_id: gemId, fixed_in: "4.4.0" }));

    const fixed = (await (await check("4.4.0", "192.0.2.149")).json()) as { affected: { advisory_id: string }[] };
    expect(fixed.affected.map((x) => x.advisory_id)).not.toContain(gemId);
  });
});
