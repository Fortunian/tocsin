import { describe, expect, it } from "vitest";
import { matchAdvisory } from "../../src/check/match";
import { fixesFrom, normalizeGithubRuntimeAdvisory, parseRangeBounds, rangesFor, type NormalizeOptions } from "../../src/ingest/github-runtime";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";

// The range and patched strings are the real values the plan session read
// from the denoland/deno advisories on 2026-10-23. The entries around them
// are SYNTHETIC (tests/fixtures/deno-runtime/README.md).

function entry(vulns: { name?: string; ecosystem?: string; range: string; patched: string }[], over: Record<string, unknown> = {}) {
  return {
    ghsa_id: "GHSA-2222-2222-2222",
    cve_id: "CVE-2099-41001",
    html_url: "https://github.com/denoland/deno/security/advisories/GHSA-2222-2222-2222",
    summary: "Synthetic: table entry",
    severity: "high",
    state: "published",
    published_at: "2026-10-12T12:00:00Z",
    updated_at: "2026-10-12T13:00:00Z",
    withdrawn_at: null,
    vulnerabilities: vulns.map((v) => ({
      package: { ecosystem: v.ecosystem ?? "deno", name: v.name ?? "" },
      vulnerable_version_range: v.range,
      patched_versions: v.patched,
      vulnerable_functions: [],
    })),
    cvss_severities: { cvss_v3: { vector_string: null, score: 0.0 }, cvss_v4: { vector_string: null, score: 0.0 } },
    ...over,
  };
}

const OPTS: NormalizeOptions = { runtime: "deno", source: "deno-runtime", excludePackage: /_/ };

function docOf(raw: unknown, opts: NormalizeOptions = OPTS): Advisory {
  const r = normalizeGithubRuntimeAdvisory(raw, opts);
  if (!r.ok) throw new Error(`not ok: ${r.reason}`);
  const doc = { id: "tcs_00000000000000000000000000", ...r.doc };
  const v = validateAdvisory(doc);
  if (!v.ok) throw new Error(v.errors.join("; "));
  return doc;
}

const fixedIn = (doc: Advisory, version: string) => {
  const m = matchAdvisory({ ecosystem: "deno", name: "deno", version }, doc);
  return m.affected ? (m.fixed_in ?? "affected-no-fix") : null;
};

interface Row {
  range: string;
  patched: string;
  bounds: { lower: string; lt: string[]; le: string[] };
  fixes: string[];
  affected: { introduced: string; fixed: string }[];
  // version -> fixed_in, or null for not affected
  checks: [string, string | null][];
  released?: string[];
}

const ROWS: Row[] = [
  { range: "<= 2.7.4", patched: "2.7.5", bounds: { lower: "0", lt: [], le: ["2.7.4"] }, fixes: ["2.7.5"], affected: [{ introduced: "0", fixed: "2.7.5" }], checks: [["1.0.0", "2.7.5"], ["2.7.4", "2.7.5"], ["2.7.5", null], ["2.7.6", null]] },
  { range: "<=2.7.11", patched: "2.7.12", bounds: { lower: "0", lt: [], le: ["2.7.11"] }, fixes: ["2.7.12"], affected: [{ introduced: "0", fixed: "2.7.12" }], checks: [["2.7.11", "2.7.12"], ["2.7.12", null]] },
  { range: "2.7.14", patched: "2.7.15", bounds: { lower: "2.7.14", lt: [], le: [] }, fixes: ["2.7.15"], affected: [{ introduced: "2.7.14", fixed: "2.7.15" }], checks: [["2.7.13", null], ["2.7.14", "2.7.15"], ["2.7.15", null]] },
  {
    range: ">=2.0.0",
    patched: "2.2.15, 2.5.2",
    bounds: { lower: "2.0.0", lt: [], le: [] },
    fixes: ["2.2.15", "2.5.2"],
    affected: [{ introduced: "2.0.0", fixed: "2.2.15" }, { introduced: "2.3.0", fixed: "2.5.2" }],
    checks: [["1.46.0", null], ["2.0.0", "2.2.15"], ["2.2.14", "2.2.15"], ["2.2.15", null], ["2.2.16", null], ["2.3.4", "2.5.2"], ["2.5.2", null]],
  },
  { range: "< v2.7.10", patched: "v2.7.10", bounds: { lower: "0", lt: ["2.7.10"], le: [] }, fixes: ["2.7.10"], affected: [{ introduced: "0", fixed: "2.7.10" }], checks: [["2.7.9", "2.7.10"], ["2.7.10", null]] },
  { range: " >= v2.7.0", patched: "2.7.5", bounds: { lower: "2.7.0", lt: [], le: [] }, fixes: ["2.7.5"], affected: [{ introduced: "2.7.0", fixed: "2.7.5" }], checks: [["2.6.9", null], ["2.7.0", "2.7.5"], ["2.7.5", null]] },
  {
    range: "> 1.46.0 <= 2.1.6",
    patched: "2.1.7",
    bounds: { lower: "1.46.1", lt: [], le: ["2.1.6"] },
    fixes: ["2.1.7"],
    affected: [{ introduced: "1.46.1", fixed: "2.1.7" }],
    checks: [["1.46.0", null], ["1.46.1", "2.1.7"], ["2.1.0", "2.1.7"], ["2.1.6", "2.1.7"], ["2.1.7", null]],
  },
  {
    range: "<=2.1.12, <=2.2.12",
    patched: "2.1.13, >=2.2.13",
    bounds: { lower: "0", lt: [], le: ["2.1.12", "2.2.12"] },
    fixes: ["2.1.13", "2.2.13"],
    affected: [{ introduced: "0", fixed: "2.1.13" }, { introduced: "2.2.0", fixed: "2.2.13" }],
    checks: [["2.1.12", "2.1.13"], ["2.1.13", null], ["2.2.12", "2.2.13"], ["2.2.13", null]],
  },
  {
    range: "<1.46.4, <2.1.2",
    patched: "2.1.2",
    bounds: { lower: "0", lt: ["1.46.4", "2.1.2"], le: [] },
    fixes: ["1.46.4", "2.1.2"],
    affected: [{ introduced: "0", fixed: "1.46.4" }, { introduced: "1.47.0", fixed: "2.1.2" }],
    checks: [["1.46.3", "1.46.4"], ["1.46.4", null], ["2.1.1", "2.1.2"], ["2.1.2", null]],
  },
  {
    range: "1.5.0 - 1.10.1",
    patched: "1.10.2",
    bounds: { lower: "1.5.0", lt: [], le: ["1.10.1"] },
    fixes: ["1.10.2"],
    affected: [{ introduced: "1.5.0", fixed: "1.10.2" }],
    checks: [["1.4.9", null], ["1.5.0", "1.10.2"], ["1.10.1", "1.10.2"], ["1.10.2", null]],
  },
  { range: "=1.34.0", patched: "1.34.1", bounds: { lower: "1.34.0", lt: [], le: [] }, fixes: ["1.34.1"], affected: [{ introduced: "1.34.0", fixed: "1.34.1" }], checks: [["1.33.9", null], ["1.34.0", "1.34.1"], ["1.34.1", null]] },
  { range: ">= 1.9", patched: ">= 2.2.5", bounds: { lower: "1.9.0", lt: [], le: [] }, fixes: ["2.2.5"], affected: [{ introduced: "1.9.0", fixed: "2.2.5" }], checks: [["1.8.9", null], ["1.9.0", "2.2.5"], ["2.2.5", null]] },
  {
    range: "<= 2.7.4",
    patched: "2.1.13, 2.2.13, >=2.3.3",
    bounds: { lower: "0", lt: [], le: ["2.7.4"] },
    fixes: ["2.1.13", "2.2.13", "2.3.3"],
    affected: [{ introduced: "0", fixed: "2.1.13" }, { introduced: "2.2.0", fixed: "2.2.13" }, { introduced: "2.3.0", fixed: "2.3.3" }],
    checks: [["2.1.12", "2.1.13"], ["2.2.14", null], ["2.3.2", "2.3.3"], ["2.3.3", null]],
  },
  { range: "< 1.42.0", patched: " 1.42.0", bounds: { lower: "0", lt: ["1.42.0"], le: [] }, fixes: ["1.42.0"], affected: [{ introduced: "0", fixed: "1.42.0" }], checks: [["1.41.9", "1.42.0"], ["1.42.0", null]] },
  { range: "<1.32.1", patched: ">= 1.32.1", bounds: { lower: "0", lt: ["1.32.1"], le: [] }, fixes: ["1.32.1"], affected: [{ introduced: "0", fixed: "1.32.1" }], checks: [["1.32.0", "1.32.1"], ["1.32.1", null]] },
  // patched_versions is authoritative per release line: `< 1.43.0` does not add a fix on the 1.43 line.
  { range: "< 1.43.0", patched: "1.43.1", bounds: { lower: "0", lt: ["1.43.0"], le: [] }, fixes: ["1.43.1"], affected: [{ introduced: "0", fixed: "1.43.1" }], checks: [["1.43.0", "1.43.1"], ["1.43.1", null]] },
  // Empty patched_versions: the fix comes from the released versions.
  {
    range: ">= 1.36.2, < 1.40.3",
    patched: "",
    bounds: { lower: "1.36.2", lt: ["1.40.3"], le: [] },
    fixes: [],
    released: ["1.40.2", "1.40.3", "1.40.4"],
    affected: [{ introduced: "1.36.2", fixed: "1.40.3" }],
    checks: [["1.36.1", null], ["1.36.2", "1.40.3"], ["1.40.2", "1.40.3"], ["1.40.3", null]],
  },
  {
    range: "<= 1.40.2",
    patched: "",
    bounds: { lower: "0", lt: [], le: ["1.40.2"] },
    fixes: [],
    released: ["1.40.4", "1.41.0", "1.40.3", "1.40.2"],
    affected: [{ introduced: "0", fixed: "1.40.3" }],
    checks: [["1.40.2", "1.40.3"], ["1.40.3", null]],
  },
];

describe("github-runtime normalizer: decision table over the real strings", () => {
  for (const row of ROWS) {
    it(`range ${JSON.stringify(row.range)} patched ${JSON.stringify(row.patched)}`, () => {
      const b = parseRangeBounds(row.range);
      expect(b).toEqual(row.bounds);
      expect(fixesFrom(row.patched, b.lt)).toEqual(row.fixes);
      const raw = entry([{ range: row.range, patched: row.patched }]);
      const doc = docOf(raw, row.released ? { ...OPTS, released: new Set(row.released) } : OPTS);
      expect(doc.affected).toEqual(row.affected);
      expect(doc.fixed_versions).toEqual(row.affected.map((a) => a.fixed));
      for (const [version, want] of row.checks) expect([version, fixedIn(doc, version)]).toEqual([version, want]);
    });
  }

  it("rangesFor: introduced is 0 when the lower bound is not below the first fix", () => {
    expect(rangesFor("2.0.0", ["1.46.4", "2.1.2"])).toEqual([{ introduced: "0", fixed: "1.46.4" }, { introduced: "1.47.0", fixed: "2.1.2" }]);
  });
});

describe("github-runtime normalizer: empty patched_versions", () => {
  const raw = entry([{ range: ">= 1.36.2, < 1.40.3", patched: "" }]);

  it("needs the releases when they are not loaded", () => {
    const r = normalizeGithubRuntimeAdvisory(raw, OPTS);
    expect(r).toMatchObject({ ok: false, needsReleases: true });
  });

  it("is terminal (no fixed deno version) when the releases do not hold the bound", () => {
    const r = normalizeGithubRuntimeAdvisory(raw, { ...OPTS, released: new Set(["1.40.2", "1.40.4"]) });
    expect(r).toEqual({ ok: false, code: "no_fix", reason: "no fixed deno version" });
  });

  it("needs no releases read when the range has no upper bound", () => {
    const r = normalizeGithubRuntimeAdvisory(entry([{ range: ">=2.0.0", patched: "" }]), OPTS);
    expect(r).toEqual({ ok: false, code: "no_fix", reason: "no fixed deno version" });
  });
});

describe("github-runtime normalizer: entries and fields", () => {
  it("drops library crates and keeps the runtime entries, whatever the package ecosystem", () => {
    for (const name of ["deno_fetch", "deno_runtime", "deno_doc", "serde_v8"]) {
      const r = normalizeGithubRuntimeAdvisory(entry([{ ecosystem: "rust", name, range: "<1.0.0", patched: "1.0.0" }]), OPTS);
      expect([name, r]).toEqual([name, { ok: false, code: "skip", reason: "no deno package entry" }]);
    }
    for (const [ecosystem, name] of [["deno", ""], ["rust", "deno"], ["", "Deno"], ["rust", "denoland/deno"], ["deno", "node:crypto"], ["composer", ""], ["npm", "bun"]]) {
      expect([name, normalizeGithubRuntimeAdvisory(entry([{ ecosystem, name, range: "<1.0.0", patched: "1.0.0" }]), OPTS).ok]).toEqual([name, true]);
    }
  });

  it("an advisory with a crate entry and a runtime entry uses only the runtime entry", () => {
    const doc = docOf(entry([{ ecosystem: "rust", name: "deno_fetch", range: "<0.100.0", patched: "0.100.0" }, { range: "<1.46.4, <2.1.2", patched: "2.1.2" }]));
    expect(doc.fixed_versions).toEqual(["1.46.4", "2.1.2"]);
  });

  it("withdrawn, not published and a bad GHSA id are terminal", () => {
    const v = [{ range: "<1.0.0", patched: "1.0.0" }];
    expect(normalizeGithubRuntimeAdvisory(entry(v, { withdrawn_at: "2026-10-02T00:00:00Z" }), OPTS)).toEqual({ ok: false, code: "skip", reason: "withdrawn" });
    expect(normalizeGithubRuntimeAdvisory(entry(v, { state: "draft" }), OPTS)).toEqual({ ok: false, code: "skip", reason: "state draft" });
    expect(normalizeGithubRuntimeAdvisory(entry(v, { ghsa_id: "GHSA-0000" }), OPTS)).toMatchObject({ ok: false, code: "skip" });
    expect(normalizeGithubRuntimeAdvisory(null, OPTS)).toMatchObject({ ok: false, code: "skip" });
  });

  it("moderate maps to medium; an unknown label is unknown; a 0.0 score with no vector is no score", () => {
    const v = [{ range: "<1.0.0", patched: "1.0.0" }];
    expect(docOf(entry(v, { severity: "moderate" })).severity).toEqual({ label: "medium" });
    expect(docOf(entry(v, { severity: null })).severity).toEqual({ label: "unknown" });
    expect(docOf(entry(v, { severity: "critical", cvss_severities: { cvss_v3: { vector_string: "CVSS:3.1/AV:N", score: 9.8 }, cvss_v4: { vector_string: null, score: 0 } } })).severity).toEqual({
      label: "critical",
      score: 9.8,
    });
  });

  it("builds the doc fields: ids, dates, summary, references, sources, bun runtime", () => {
    const raw = entry([{ ecosystem: "npm", name: "bun", range: "<= 1.1.30", patched: "1.1.31" }], {
      ghsa_id: "GHSA-6666-7777-8888",
      cve_id: "not-a-cve",
      html_url: "https://github.com/oven-sh/bun/security/advisories/GHSA-6666-7777-8888",
      summary: "  Line one\n line two  ",
      updated_at: null,
    });
    const doc = docOf(raw, { runtime: "bun", source: "bun-runtime", excludePackage: /_/ });
    expect(doc).toMatchObject({
      cve_ids: [],
      ghsa_id: "GHSA-6666-7777-8888",
      ecosystem: "bun",
      component: "bun",
      published_at: "2026-10-12T12:00:00Z",
      modified_at: "2026-10-12T12:00:00Z",
      summary: "Line one line two",
      action: "Upgrade bun to 1.1.31 or later.",
      references: ["https://github.com/oven-sh/bun/security/advisories/GHSA-6666-7777-8888"],
      sources: [{ source: "bun-runtime", source_id: "GHSA-6666-7777-8888", url: "https://github.com/oven-sh/bun/security/advisories/GHSA-6666-7777-8888" }],
      exploited: false,
    });
  });

  it("the action names every line, and falls back to the lowest fix past 200 chars", () => {
    expect(docOf(entry([{ range: "<= 2.7.4", patched: "2.1.13, 2.2.13, >=2.3.3" }])).action).toBe("Upgrade deno to 2.1.13 (2.1.x), 2.2.13 (2.2.x) or 2.3.3 or later.");
    const many = Array.from({ length: 30 }, (_, i) => `2.${i}.1`).join(", ");
    const doc = docOf(entry([{ range: "<= 2.30.0", patched: many }]));
    expect(doc.action.length).toBeLessThanOrEqual(200);
    expect(doc.action).toBe("Upgrade deno to 2.0.1 or later.");
  });
});
