import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../../src/index";
import { baseEcosystem, DEFAULT_ECOSYSTEMS, normalizeOsv, NOT_ENABLED_REASON, osv, type OsvVuln } from "../../src/ingest/osv";
import type { IngestContext } from "../../src/ingest/types";
import { validateAdvisory } from "../../src/schema/advisory";
import debianFixture from "../fixtures/osv/debian-12.tcs-71.json";
import drupalFixture from "../fixtures/osv/drupal-contrib-2017-082.tcs-71.json";
import { createOsvFake, FAKE_API_BASE, FAKE_CSV_BASE, type FakeRecord } from "./osv-fake";

// TCS-71: OSV writes some ecosystems with a suffix (Packagist:https://packages.drupal.org/8,
// Debian:12). normalizeOsv matches on the base name (the part before the first ":"),
// stores ecosystem as the base name and keeps the full OSV string in ecosystem_qualifier.
//
// drupal-contrib-2017-082.tcs-71.json, source: assumed. api.osv.dev and the OSV
// bucket were not reachable from the build box (egress proxy 403), so the record
// is hand-written in the OSV shape: the id, the suffixed ecosystem string, the
// package name and the ECOSYSTEM range 0 -> 1.35.0 come from the ticket and plan;
// text, dates and reference are placeholders.
// debian-12.tcs-71.json, source: assumed (a minimal record with one Debian:12 package).
//
// Each test uses its own record id (suffix -tcs71<tag>), so tests never share rows.

const TOKEN = "tok-fixture-import-71";
const QUALIFIER = "Packagist:https://packages.drupal.org/8";
const COMPONENT = "drupal/permissions_by_term";

function drupal(tag = ""): OsvVuln {
  const r = structuredClone(drupalFixture) as unknown as OsvVuln;
  if (tag) r.id = `${r.id}-tcs71${tag}`;
  return r;
}

function debian(tag = ""): OsvVuln {
  const r = structuredClone(debianFixture) as unknown as OsvVuln;
  if (tag) r.id = `${r.id}-tcs71${tag}`;
  return r;
}

function withEcosystem(id: string, ecosystem: string | undefined, name: string | undefined): OsvVuln {
  const r = drupal();
  r.id = id;
  r.affected = [{ package: { ecosystem, name }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.0" }] }] }];
  return r;
}

async function importPost(body: unknown): Promise<Response> {
  const e = { ...env, IMPORT_TOKEN: TOKEN } as typeof env & { IMPORT_TOKEN: string };
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://tocsin.test/v1/internal/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function check(version: string, ip: string): Promise<{ affected: { advisory_id: string; fixed_in: string | null }[] }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://tocsin.test/v1/check", {
      method: "POST",
      headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
      body: JSON.stringify({ dependencies: [{ ecosystem: "Packagist", name: COMPONENT, version }] }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { affected: { advisory_id: string; fixed_in: string | null }[] };
}

const advisoryFor = (sourceId: string) =>
  env.DB.prepare(
    "SELECT a.id, a.ecosystem, a.component, a.doc_json FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id = ?",
  )
    .bind(sourceId)
    .first<{ id: string; ecosystem: string; component: string; doc_json: string }>();

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterAll(() => {
  // Every OSV read in this file goes through the fake: 0 real network calls.
  expect(fetchSpy).toHaveBeenCalledTimes(0);
  fetchSpy.mockRestore();
});

beforeEach(async () => {
  // The default enabled list (DEFAULT_ECOSYSTEMS): Packagist yes, Debian no.
  await env.DB.prepare("UPDATE sources SET config_json = '{}' WHERE id = 'osv'").run();
  await env.DB.prepare("DELETE FROM backfill WHERE ecosystem = 'Packagist'").run();
});

describe("baseEcosystem", () => {
  it("is the part before the first ':'", () => {
    expect(baseEcosystem("Packagist")).toBe("Packagist");
    expect(baseEcosystem(QUALIFIER)).toBe("Packagist");
    expect(baseEcosystem("Debian:12")).toBe("Debian");
    expect(baseEcosystem("Maven:https://repo.example/x")).toBe("Maven");
    expect(baseEcosystem("Packagist:")).toBe("Packagist");
    expect(baseEcosystem(":Packagist")).toBe("");
  });
});

describe("normalizeOsv with a suffixed ecosystem (normalize)", () => {
  it("normalize: DRUPAL-CONTRIB-2017-082 gives one Packagist doc with the range and the qualifier", () => {
    const r = normalizeOsv(drupal(), DEFAULT_ECOSYSTEMS);
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.docs).toHaveLength(1);
    const doc = r.doc;
    expect(doc.ecosystem).toBe("Packagist");
    expect(doc.component).toBe(COMPONENT);
    expect(doc.affected).toEqual([{ introduced: "0", fixed: "1.35.0" }]);
    expect(doc.fixed_versions).toEqual(["1.35.0"]);
    expect(doc.ecosystem_qualifier).toBe(QUALIFIER);
    expect(doc.sources[0].source_id).toBe("DRUPAL-CONTRIB-2017-082");
    expect(r.docs[0].source_id).toBe("DRUPAL-CONTRIB-2017-082");
    const valid = validateAdvisory({ ...doc, id: "tcs_00000000000000000000000071" });
    expect(valid.ok ? [] : valid.errors).toEqual([]);
  });

  it("normalize: a plain Packagist record gets no ecosystem_qualifier key", () => {
    const r = normalizeOsv(withEcosystem("GHSA-tcs71-plain", "Packagist", "tcs71/pkg"), DEFAULT_ECOSYSTEMS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.ecosystem).toBe("Packagist");
    expect("ecosystem_qualifier" in r.doc).toBe(false);
    const valid = validateAdvisory({ ...r.doc, id: "tcs_00000000000000000000000072" });
    expect(valid.ok ? [] : valid.errors).toEqual([]);
  });

  it("normalize: 'Packagist:' (empty suffix) keeps the qualifier 'Packagist:'", () => {
    const r = normalizeOsv(withEcosystem("GHSA-tcs71-empty", "Packagist:", "tcs71/pkg"), ["Packagist"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.ecosystem).toBe("Packagist");
    expect(r.doc.ecosystem_qualifier).toBe("Packagist:");
  });

  it("normalize negatives: no near miss produces a Packagist advisory", () => {
    const cases: [string | undefined, string | undefined][] = [
      ["Debian:12", "pkg"],
      ["Alpine:v3.18", "pkg"],
      ["Ubuntu:22.04", "pkg"],
      ["Maven:https://repo.example/x", "pkg"],
      ["PackagistX", "pkg"],
      ["packagist", "pkg"],
      [":Packagist", "pkg"],
      ["Packagist:https://packages.drupal.org/8", undefined],
    ];
    for (const [eco, name] of cases) {
      expect(normalizeOsv(withEcosystem("GHSA-tcs71-neg", eco, name), ["Packagist"]), `${eco}/${name}`).toEqual({
        ok: false,
        reason: NOT_ENABLED_REASON,
      });
    }
    expect(normalizeOsv(debian(), DEFAULT_ECOSYSTEMS)).toEqual({ ok: false, reason: NOT_ENABLED_REASON });
    // The reason text other tickets pin does not change.
    expect(NOT_ENABLED_REASON).toBe("no affected package in a listed ecosystem");
  });

  it("normalize: a plain and a suffixed entry for one name give one doc with both ranges", () => {
    const v = drupal("both");
    v.affected = [
      { package: { ecosystem: "Packagist", name: COMPONENT }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.0.0" }, { fixed: "2.1.0" }] }] },
      ...v.affected!,
    ];
    const r = normalizeOsv(v, ["Packagist"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docs).toHaveLength(1);
    expect(r.doc.ecosystem_qualifier).toBe(QUALIFIER);
    expect(r.doc.affected).toEqual([
      { introduced: "2.0.0", fixed: "2.1.0" },
      { introduced: "0", fixed: "1.35.0" },
    ]);
  });
});

describe("import route (POST /v1/internal/import)", () => {
  it("import route: the Drupal record imports; a Debian:12 record is skipped as ecosystem_not_enabled; a re-run is unchanged; /v1/check finds 8.x-1.0", async () => {
    const records = [drupal(), debian()];
    const res = await importPost({ ecosystem: "Packagist", records, skipped: 0, last_id: "DRUPAL-CONTRIB-2017-082", start: true });
    expect(res.status, await res.clone().text()).toBe(200);
    const a = (await res.json()) as Record<string, unknown>;
    expect(a).toMatchObject({ imported: 1, unchanged: 0, inserted: 1, skipped: 1, skipped_reasons: { ecosystem_not_enabled: 1 }, errors: [] });

    const row = await env.DB.prepare("SELECT imported, skipped FROM backfill WHERE ecosystem = 'Packagist'").first();
    expect(row).toEqual({ imported: 1, skipped: 1 });
    const stored = await advisoryFor("DRUPAL-CONTRIB-2017-082");
    expect(stored).toMatchObject({ ecosystem: "Packagist", component: COMPONENT });
    expect(JSON.parse(stored!.doc_json).ecosystem_qualifier).toBe(QUALIFIER);

    // The second run of the same batch (a new run, start: true) is unchanged.
    const again = await importPost({ ecosystem: "Packagist", records, skipped: 0, last_id: "DRUPAL-CONTRIB-2017-082", start: true });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ imported: 0, unchanged: 1, inserted: 0, skipped: 1, errors: [] });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisory_sources WHERE source = 'osv' AND source_id = 'DRUPAL-CONTRIB-2017-082'").first<{ n: number }>();
    expect(n!.n).toBe(1);

    const hit = await check("8.x-1.0", "192.0.2.171");
    expect(hit.affected).toContainEqual(expect.objectContaining({ advisory_id: stored!.id, fixed_in: "1.35.0" }));
    const fixed = await check("1.35.0", "192.0.2.172");
    expect(fixed.affected.map((x) => x.advisory_id)).not.toContain(stored!.id);
  });

  it("import route: a malformed record is still an error, not a skip", async () => {
    const bad = drupal("bad") as Partial<OsvVuln>;
    delete bad.modified;
    const res = await importPost({ ecosystem: "Packagist", records: [bad], skipped: 0, last_id: "DRUPAL-CONTRIB-2017-082-tcs71bad", start: true });
    expect(res.status).toBe(200);
    const a = (await res.json()) as { skipped: number; skipped_reasons: Record<string, number>; errors: string[] };
    expect(a.skipped).toBe(0);
    expect(a.skipped_reasons).toEqual({ ecosystem_not_enabled: 0 });
    expect(a.errors).toEqual(["DRUPAL-CONTRIB-2017-082-tcs71bad: record has no modified"]);
  });
});

describe("cron (osv.run) uses the same normalizeOsv", () => {
  it("cron: the Drupal id in the Packagist CSV upserts one Packagist advisory with no error line", async () => {
    const v = drupal("c");
    await env.CURSORS.put("cursor:osv", "2000-01-01T00:00:00Z");
    const fake = createOsvFake([v as unknown as FakeRecord], { extraRows: [{ ecosystem: "Packagist", modified: v.modified, id: v.id }] });
    const ctx: IngestContext = {
      env,
      source: { id: "osv", kind: "osv", config: { csv_base: FAKE_CSV_BASE, api_base: FAKE_API_BASE } },
      now: () => new Date("2026-10-23T00:00:00Z"),
      fetch: fake.fetch,
    };
    expect(await osv.run(ctx)).toEqual({ fetched: 1, upserted: 1, unchanged: 0, errors: [] });
    const stored = await advisoryFor(v.id);
    expect(stored).toMatchObject({ ecosystem: "Packagist", component: COMPONENT });
    expect(JSON.parse(stored!.doc_json).ecosystem_qualifier).toBe(QUALIFIER);
  });
});
