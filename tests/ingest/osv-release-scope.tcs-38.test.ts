import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { normalizeOsv, NOT_ENABLED_REASON, RELEASE_SCOPED, type OsvVuln } from "../../src/ingest/osv";
import { validateAdvisory } from "../../src/schema/advisory";
import alpineAssumed from "../fixtures/osv/tcs-38/alpine.assumed.json";
import alpine5407 from "../fixtures/osv/tcs-38/Alpine/CVE-2018-5407.json";
import debianAssumed from "../fixtures/osv/tcs-38/debian.assumed.json";
import drupalFixture from "../fixtures/osv/drupal-contrib-2017-082.tcs-71.json";

// TCS-38: OSV writes Alpine and Debian packages per release (Alpine:v3.18,
// Debian:12), and one package has a different fix per release. normalizeOsv
// keeps one doc per (release, package) for these two ecosystems; every other
// ecosystem keeps one doc per (base ecosystem, package) as in TCS-71.
// Each test uses its own record id (suffix -tcs38<tag>), so tests never share rows.

const TOKEN = "tok-fixture-import-38rs";

function record(list: unknown, id: string, tag = ""): OsvVuln {
  const r = structuredClone((list as OsvVuln[]).find((x) => x.id === id)!);
  if (tag) r.id = `${r.id}-tcs38${tag}`;
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

describe("normalizeOsv: release scope for Alpine and Debian", () => {
  it("RELEASE_SCOPED is Alpine and Debian", () => {
    expect([...RELEASE_SCOPED].sort()).toEqual(["Alpine", "Debian"]);
  });

  it("a two-release Debian record gives 2 docs with their own qualifier, source id and range", () => {
    const r = normalizeOsv(record(debianAssumed, "TCS38-DEBIAN-01"), ["Debian"]);
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.docs.map((d) => d.source_id)).toEqual(["TCS38-DEBIAN-01", "TCS38-DEBIAN-01#Debian:12/openssl"]);
    expect(r.docs.map((d) => [d.doc.ecosystem, d.doc.ecosystem_qualifier, d.doc.component])).toEqual([
      ["Debian", "Debian:11", "openssl"],
      ["Debian", "Debian:12", "openssl"],
    ]);
    expect(r.docs[0].doc.affected).toEqual([{ introduced: "0", fixed: "1.1.1w-0+deb11u1" }]);
    expect(r.docs[1].doc.affected).toEqual([{ introduced: "0", fixed: "3.0.11-1~deb12u2" }]);
    expect(r.docs[1].doc.fixed_versions).toEqual(["3.0.11-1~deb12u2"]);
    expect(r.docs[1].doc.sources[0].source_id).toBe("TCS38-DEBIAN-01#Debian:12/openssl");
    for (const [i, d] of r.docs.entries()) {
      const v = validateAdvisory({ ...d.doc, id: `tcs_0000000000000000000000038${i}` });
      expect(v.ok ? [] : v.errors).toEqual([]);
    }
  });

  it("the recorded Alpine CVE-2018-5407 (six releases and one GIT entry with no ecosystem) gives six docs", () => {
    const r = normalizeOsv(alpine5407 as unknown as OsvVuln, ["Alpine"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docs.map((d) => d.doc.ecosystem_qualifier)).toEqual(["Alpine:v3.3", "Alpine:v3.4", "Alpine:v3.5", "Alpine:v3.6", "Alpine:v3.7", "Alpine:v3.8"]);
    expect(new Set(r.docs.map((d) => d.source_id)).size).toBe(6);
    expect(r.docs[5].source_id).toBe("CVE-2018-5407#Alpine:v3.8/openssl");
    for (const d of r.docs) expect(d.doc.affected).toEqual([{ introduced: "0", fixed: "1.0.2q-r0" }]);
  });

  it("a bare Debian or Alpine entry (no release) is skipped; a record with only such entries is not stored", () => {
    const v = record(debianAssumed, "TCS38-DEBIAN-02", "bare");
    v.affected = [{ package: { ecosystem: "Debian", name: "audit" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1:3.0.9-1+deb12u1" }] }] }];
    expect(normalizeOsv(v, ["Debian"])).toEqual({ ok: false, reason: "no release on an OS package" });
    v.affected.push({ package: { ecosystem: "Debian:", name: "audit" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }] }] });
    expect(normalizeOsv(v, ["Debian"])).toEqual({ ok: false, reason: "no release on an OS package" });
    v.affected.push({ package: { ecosystem: "Debian:12", name: "audit" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1:3.0.9-1+deb12u1" }] }] });
    const r = normalizeOsv(v, ["Debian"]);
    expect(r.ok && r.docs.map((d) => d.doc.ecosystem_qualifier)).toEqual(["Debian:12"]);
    // Not enabled stays the not-enabled reason.
    expect(normalizeOsv(record(debianAssumed, "TCS38-DEBIAN-01"), ["npm"])).toEqual({ ok: false, reason: NOT_ENABLED_REASON });
  });

  it("Packagist is unchanged: a plain and a suffixed entry for one name still give one doc", () => {
    const v = structuredClone(drupalFixture) as unknown as OsvVuln;
    v.affected = [
      { package: { ecosystem: "Packagist", name: "drupal/permissions_by_term" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.0.0" }, { fixed: "2.1.0" }] }] },
      ...v.affected!,
    ];
    const r = normalizeOsv(v, ["Packagist"]);
    expect(r.ok && r.docs.map((d) => [d.source_id, d.doc.ecosystem_qualifier])).toEqual([["DRUPAL-CONTRIB-2017-082", "Packagist:https://packages.drupal.org/8"]]);
  });
});

describe("import route and /v1/check with release-scoped docs", () => {
  it("imports a two-release record as two advisories; a re-run is unchanged; each release matches only its own doc", async () => {
    const v = record(debianAssumed, "TCS38-DEBIAN-01", "imp");
    const first = await importPost({ ecosystem: "Debian", records: [v], skipped: 0, last_id: v.id, start: true });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toMatchObject({ imported: 1, inserted: 2, errors: [] });
    const again = await importPost({ ecosystem: "Debian", records: [v], skipped: 0, last_id: v.id, start: true });
    expect(await again.json()).toMatchObject({ imported: 0, unchanged: 1, inserted: 0, updated: 0, errors: [] });

    const rows = await env.DB.prepare(
      "SELECT s.source_id, a.id, a.ecosystem FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id LIKE ? ORDER BY s.source_id",
    )
      .bind(`${v.id}%`)
      .all<{ source_id: string; id: string; ecosystem: string }>();
    expect(rows.results.map((r) => r.source_id)).toEqual([v.id, `${v.id}#Debian:12/openssl`]);
    const d12 = rows.results[1].id;

    const check = async (eco: string, ip: string) => {
      const res = await exports.default.fetch("https://tocsin.test/v1/check", {
        method: "POST",
        headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
        body: JSON.stringify({ dependencies: [{ ecosystem: eco, name: "openssl", version: "1.1.1w-0+deb11u1" }] }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { affected: { advisory_id: string; fixed_in: string }[]; skipped: { reason: string }[]; coverage: { ecosystem: string; complete: boolean }[] };
    };
    // Debian 12 at the Debian 11 fix: affected by the Debian 12 doc only.
    const d12Check = await check("Debian:12", "192.0.2.191");
    expect(d12Check.affected.map((a) => [a.advisory_id, a.fixed_in])).toEqual([[d12, "3.0.11-1~deb12u2"]]);
    expect(d12Check.coverage).toMatchObject([{ ecosystem: "Debian:12", complete: false }]);
    // Debian 11 at its own fix: not affected (the Debian 12 range is not its range).
    const d11Check = await check("Debian:11", "192.0.2.192");
    expect(d11Check.affected).toEqual([]);
    expect(d11Check.skipped.map((s) => s.reason)).toEqual(["partial_coverage"]);
  });

  it("a done Alpine backfill makes Alpine:v3.15 coverage complete: the release follows the base row", async () => {
    const v = record(alpineAssumed, "TCS38-ALPINE-02", "cov");
    const res = await importPost({ ecosystem: "Alpine", records: [v], skipped: 0, last_id: v.id, start: true, final: true });
    expect(await res.json()).toMatchObject({ imported: 1, errors: [] });
    const out = await exports.default.fetch("https://tocsin.test/v1/check", {
      method: "POST",
      headers: { "CF-Connecting-IP": "192.0.2.193", "Content-Type": "application/json" },
      body: JSON.stringify({ dependencies: [{ ecosystem: "Alpine:v3.15", name: "zlib", version: "1.2.12-r2" }] }),
    });
    const a = (await out.json()) as { affected: unknown[]; skipped: unknown[]; coverage: { ecosystem: string; complete: boolean }[] };
    expect(a.coverage).toMatchObject([{ ecosystem: "Alpine:v3.15", complete: true }]);
    // Complete coverage and no finding: a clean result, not partial_coverage.
    expect(a.affected).toEqual([]);
    expect(a.skipped).toEqual([]);
  });

  it("the Alpine assumed record imports two release docs through the route", async () => {
    const v = record(alpineAssumed, "TCS38-ALPINE-09", "imp");
    const res = await importPost({ ecosystem: "Alpine", records: [v], skipped: 0, last_id: v.id, start: true });
    expect(await res.json()).toMatchObject({ imported: 1, inserted: 2, errors: [] });
  });
});
