import { describe, expect, it } from "vitest";
import { matchAdvisory, supportsEcosystem } from "../../src/check/match";
import { apkComparator } from "../../src/check/match/apk";
import type { OsvVuln } from "../../src/ingest/osv";
import r5407 from "../fixtures/osv/tcs-38/Alpine/CVE-2018-5407.json";
import assumed from "../fixtures/osv/tcs-38/alpine.assumed.json";
import { advisoriesOf, expectAscending, expectInvalid, expectRecordCases } from "./ecosystem-cases.tcs-38";

// TCS-38: Alpine uses apk-tools version order: dotted numbers, an optional
// letter, suffixes _alpha < _beta < _pre < _rc < (none) < _cvs < _svn < _git
// < _hg < _p (each with an optional number), then -r<N>.

describe("Alpine (apk) comparator", () => {
  it("orders suffixes, letters and revisions", () => {
    expectAscending(apkComparator, [
      "1.2",
      "1.2.3_alpha",
      "1.2.3_alpha2",
      "1.2.3_beta2",
      "1.2.3_pre1",
      "1.2.3_rc",
      "1.2.3_rc1-r9",
      "1.2.3_rc2",
      "1.2.3",
      "1.2.3-r0",
      "1.2.3-r3",
      "1.2.3-r4",
      "1.2.3-r10",
      "1.2.3_cvs",
      "1.2.3_svn",
      "1.2.3_git20230101",
      "1.2.3_hg",
      "1.2.3_p1",
      "1.2.3_p1-r1",
      "1.2.3_p2",
      "1.2.3a",
      "1.2.3b-r1",
      "1.2.3.1",
      "1.2.4",
      "1.10",
    ]);
  });

  it("pins the ticket edge case 1.2.3-r4 > 1.2.3-r3 > 1.2.3_rc1-r9", () => {
    expect(apkComparator.compare("1.2.3-r4", "1.2.3-r3")).toBeGreaterThan(0);
    expect(apkComparator.compare("1.2.3-r3", "1.2.3_rc1-r9")).toBeGreaterThan(0);
    expect(apkComparator.compare("3.1.4-r0", "3.1.4-r1")).toBeLessThan(0);
  });

  it("rejects what apk does not parse", () => {
    expectInvalid(apkComparator, ["", " ", "v1.2.3", "1.2.3-r", "1.2.3_foo", "1.2.3-4", "1.2.3-r1-r2", "a1.0"]);
  });

  it("needs a release: Alpine:v3.18 yes, bare Alpine no; a dependency matches only the doc of its own release", () => {
    expect(supportsEcosystem("Alpine:v3.18")).toBe(true);
    expect(supportsEcosystem("Alpine")).toBe(false);
    expect(supportsEcosystem("Alpine:")).toBe(false);
    expect(supportsEcosystem("alpine:v3.18")).toBe(false);
    const doc = (qualifier: string, fixed: string) =>
      ({
        id: `tcs_TCS38APK${qualifier.replace(/\W/g, "").padStart(15, "0")}`,
        ecosystem: "Alpine",
        ecosystem_qualifier: qualifier,
        component: "openssl",
        affected: [{ introduced: "0", fixed }],
        fixed_versions: [fixed],
      }) as never;
    const v318 = doc("Alpine:v3.18", "3.1.4-r1");
    const v319 = doc("Alpine:v3.19", "3.1.4-r0");
    const dep = (eco: string, version: string) => ({ ecosystem: eco, name: "openssl", version });
    expect(matchAdvisory(dep("Alpine:v3.18", "3.1.4-r0"), v318)).toEqual({ affected: true, fixed_in: "3.1.4-r1" });
    expect(matchAdvisory(dep("Alpine:v3.18", "3.1.4-r1"), v318)).toEqual({ affected: false });
    // Cross-release negative: the v3.19 dependency at the v3.18-affected version only sees v3.19's range.
    expect(matchAdvisory(dep("Alpine:v3.19", "3.1.4-r0"), v318)).toEqual({ affected: false });
    expect(matchAdvisory(dep("Alpine:v3.19", "3.1.4-r0"), v319)).toEqual({ affected: false });
    expect(matchAdvisory(dep("Alpine", "3.1.4-r0"), v318).affected).toBe(false);
    // A Debian dependency of the same name never matches an Alpine doc.
    expect(matchAdvisory(dep("Debian:12", "3.1.4-r0"), v318).affected).toBe(false);
  });
});

// 10 OSV records (tests/fixtures/osv/tcs-38/SOURCES.md): 1 recorded copy (six releases), 9 hand-built.
// Each dependency carries its own release (Alpine:vX.Y); every doc of the record is tried.
const RECORDS = [r5407, ...assumed] as unknown as OsvVuln[];

describe("Alpine: 10 OSV records, one version inside and one outside each range", () => {
  it("matches each record through normalizeOsv and matchAdvisory, release by release", () => {
    expectRecordCases(RECORDS, ["Alpine"], [
      { id: "CVE-2018-5407", dep: "Alpine:v3.8", name: "openssl", affected: "1.0.2p-r0", notAffected: "1.0.2q-r0", fixed_in: "1.0.2q-r0" },
      { id: "TCS38-ALPINE-01", dep: "Alpine:v3.15", name: "openssl", affected: "1.1.1n-r0", notAffected: "1.1.1t-r0", fixed_in: "1.1.1t-r0" },
      { id: "TCS38-ALPINE-02", dep: "Alpine:v3.15", name: "busybox", affected: "1.34.1-r5", notAffected: "1.34.1-r6", fixed_in: "1.34.1-r6" },
      { id: "TCS38-ALPINE-03", dep: "Alpine:v3.15", name: "zlib", affected: "1.2.12-r0", notAffected: "1.2.12-r2", fixed_in: "1.2.12-r2" },
      { id: "TCS38-ALPINE-04", dep: "Alpine:v3.15", name: "musl", affected: "1.2.2-r7", notAffected: "1.2.2-r8", fixed_in: null },
      { id: "TCS38-ALPINE-05", dep: "Alpine:v3.18", name: "curl", affected: "8.4.0_rc1-r0", notAffected: "8.4.0-r0", fixed_in: "8.4.0-r0" },
      { id: "TCS38-ALPINE-06", dep: "Alpine:v3.18", name: "ncurses", affected: "6.4_p20230424-r0", notAffected: "6.4_p20230506-r0", fixed_in: "6.4_p20230506-r0" },
      { id: "TCS38-ALPINE-07", dep: "Alpine:v3.14", name: "openssl", affected: "1.1.1k-r0", notAffected: "1.1.1l-r0", fixed_in: "1.1.1l-r0" },
      { id: "TCS38-ALPINE-08", dep: "Alpine:v3.17", name: "sqlite", affected: "3.40.1-r0", notAffected: "3.41.2-r2", fixed_in: "3.41.2-r2" },
      { id: "TCS38-ALPINE-09", dep: "Alpine:v3.18", name: "expat", affected: "2.5.0-r0", notAffected: "2.6.0-r0", fixed_in: "2.6.0-r0" },
    ]);
  });

  it("cross-release negative on a recorded record: a v3.9 dependency below 1.0.2q-r0 matches none of the six release docs", () => {
    expectRecordCasesNone(RECORDS, "CVE-2018-5407", { ecosystem: "Alpine:v3.9", name: "openssl", version: "1.0.2p-r0" });
    expectRecordCasesNone(RECORDS, "TCS38-ALPINE-09", { ecosystem: "Alpine:v3.17", name: "expat", version: "2.5.0-r0" });
  });
});

function expectRecordCasesNone(records: OsvVuln[], id: string, dep: { ecosystem: string; name: string; version: string }) {
  const docs = advisoriesOf(records.find((r) => r.id === id)!, ["Alpine"]);
  expect(docs.length).toBeGreaterThan(0);
  for (const a of docs) expect(matchAdvisory(dep, a), `${id} ${a.ecosystem_qualifier}`).toEqual({ affected: false });
}
