import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_ECOSYSTEMS, normalizeOsv, type OsvVuln } from "../../src/ingest/osv";
import { upsertAdvisory } from "../../src/ingest/upsert";
import type { AdvisoryInput } from "../../src/ingest/types";
import undici from "../fixtures/osv/undici-multi-range.tcs-75.json";

// TCS-75: an OSV package with several fixed lines names each line's fix in its
// action, as the Node ingester does. One fix keeps the old sentence.
//
// undici-multi-range.tcs-75.json, source: assumed. api.osv.dev was not
// reachable from the build box on 2026-10-23 (proxy 403). The record is
// hand-written from the 3 SEMVER ranges the plan probed on
// https://api.osv.dev/v1/vulns/GHSA-rfgv-xxqx-mfg5 (modified
// 2026-09-29T18:30:41Z): 6.7.0->6.28.1, 7.0.0->7.29.1, 8.0.0->8.10.2.
// Summary, aliases, severity and references are left out on purpose (not recorded).
//
// Each test uses its own record id (suffix -tcs75<tag>), so tests never share rows.

const MULTI = "Upgrade undici to 6.28.1 (6.x), 7.29.1 (7.x) or 8.10.2 (8.x) or later.";

function rec(tag: string): OsvVuln {
  const r = structuredClone(undici) as unknown as OsvVuln;
  r.id = `${r.id}-tcs75${tag}`;
  return r;
}

function withFixes(v: OsvVuln, fixes: string[]): OsvVuln {
  const base = v.affected![0];
  v.affected = fixes.map((f) => ({ ...base, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: f }] }] }));
  return v;
}

function doc(v: OsvVuln): AdvisoryInput {
  const r = normalizeOsv(v, DEFAULT_ECOSYSTEMS);
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
}

describe("normalizeOsv action for a package with several fixed lines (TCS-75)", () => {
  it("the undici record names each line's fix", () => {
    const d = doc(rec("a"));
    expect(d.action).toBe(MULTI);
    expect(d.fixed_versions).toEqual(["6.28.1", "7.29.1", "8.10.2"]);
  });

  it("a single-range record keeps the one-version sentence; no fix keeps NO_FIX", () => {
    const one = rec("b");
    one.affected = one.affected!.slice(0, 1);
    expect(doc(one).action).toBe("Upgrade undici to 6.28.1 or later.");

    const none = rec("c");
    none.affected = [{ ...none.affected![0], ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] }];
    expect(doc(none).action).toBe("No fix published. Pin and monitor.");
  });

  it("labels go to major.minor when majors collide, and fall back when lines cannot be named or the text is too long", () => {
    expect(doc(withFixes(rec("d"), ["1.22.5", "1.21.12"])).action).toBe(
      "Upgrade undici to 1.21.12 (1.21.x) or 1.22.5 (1.22.x) or later.",
    );
    expect(doc(withFixes(rec("e"), ["1.2.3", "1.2.4"])).action).toBe(
      "Upgrade undici to the fixed version for your line (see fixed_versions).",
    );
    expect(doc(withFixes(rec("f"), ["2.0.0-rc.1", "2.0.1"])).action).toBe(
      "Upgrade undici to the fixed version for your line (see fixed_versions).",
    );
    // A segment that is not all digits (a Debian epoch), and a version too short for major.minor.
    expect(doc(withFixes(rec("i"), ["1:2.3-4", "2:3.0-1"])).action).toBe(
      "Upgrade undici to the fixed version for your line (see fixed_versions).",
    );
    expect(doc(withFixes(rec("j"), ["2", "2.1"])).action).toBe(
      "Upgrade undici to the fixed version for your line (see fixed_versions).",
    );

    const long = withFixes(rec("g"), ["6.28.1", "7.29.1"]);
    const name = "x".repeat(180);
    for (const a of long.affected!) a.package = { ecosystem: "npm", name };
    const action = doc(long).action;
    expect(action.length).toBeLessThanOrEqual(200);
    expect(action).toBe(`Upgrade ${name} to the fixed version for your line (see fixed_versions).`.slice(0, 200).trim());
    expect(action).not.toContain("6.28.1");
  });

  it("a re-read rewrites the stored action of the same (osv, id), with no second row", async () => {
    const v = rec("h");
    const fresh = doc(v);
    const old: AdvisoryInput = { ...fresh, action: "Upgrade undici to 6.28.1 or later." };
    const key = { source: "osv", source_id: v.id };
    expect(await upsertAdvisory(env.DB, old, key)).toBe("inserted");
    expect(await upsertAdvisory(env.DB, fresh, key)).toBe("updated");

    const rows = await env.DB.prepare(
      "SELECT a.doc_json FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id = ?",
    )
      .bind(v.id)
      .all<{ doc_json: string }>();
    expect(rows.results).toHaveLength(1);
    expect((JSON.parse(rows.results[0].doc_json) as AdvisoryInput).action).toBe(MULTI);
  });
});
