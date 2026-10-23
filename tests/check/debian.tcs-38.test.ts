import { describe, expect, it } from "vitest";
import { matchAdvisory, supportsEcosystem } from "../../src/check/match";
import { dpkgComparator } from "../../src/check/match/dpkg";
import type { OsvVuln } from "../../src/ingest/osv";
import assumed from "../fixtures/osv/tcs-38/debian.assumed.json";
import { advisoriesOf, expectAscending, expectInvalid, expectRecordCases } from "./ecosystem-cases.tcs-38";

// TCS-38: Debian uses dpkg version order (Debian policy 5.6.12):
// [epoch:]upstream[-revision]; `~` sorts before everything, even the end of
// the string; letters sort before other characters; digit runs compare as numbers.

describe("Debian (dpkg) comparator", () => {
  it("orders epochs, tildes, letters and revisions", () => {
    expectAscending(dpkgComparator, [
      "0.9",
      "1.0~rc1",
      "1.0~rc1-1",
      ["1.0", "1.0-0", "0:1.0"],
      ["1.0-1", "0:1.0-1"],
      "1.0-1+deb12u1",
      "1.0-2",
      "1.0a-1",
      "1.0+dfsg-1",
      "1.0.1-1",
      "2.9-1",
      "1:0.1-1",
      "1:2.3-4~deb12u1",
      "1:2.3-4",
      "1:2.3-4+deb12u1",
      "1:2.3-10",
      "2:0.1",
    ]);
  });

  it("pins the ticket edge case 1:2.3-4+deb12u1 > 2.9-1 and an epoch-only change", () => {
    expect(dpkgComparator.compare("1:2.3-4+deb12u1", "2.9-1")).toBeGreaterThan(0);
    expect(dpkgComparator.compare("1:1.0-1", "1.0-1")).toBeGreaterThan(0);
    expect(dpkgComparator.compare("2.3-4~deb12u1", "2.3-4")).toBeLessThan(0);
    expect(dpkgComparator.compare("3.0.11-1~deb12u2", "3.0.11-1~deb12u1")).toBeGreaterThan(0);
  });

  it("rejects what dpkg does not parse", () => {
    expectInvalid(dpkgComparator, ["", " ", "v1.0", "a1.0", "1.0-", ":1.0", "x:1.0", "1.0 beta", "1:"]);
  });

  it("needs a release: Debian:12 yes, bare Debian no; a dependency matches only the doc of its own release", () => {
    expect(supportsEcosystem("Debian:12")).toBe(true);
    expect(supportsEcosystem("Debian")).toBe(false);
    expect(supportsEcosystem("Debian:")).toBe(false);
    const doc = (qualifier: string, fixed: string) =>
      ({
        id: `tcs_TCS38DEB${qualifier.replace(/\W/g, "").padStart(15, "0")}`,
        ecosystem: "Debian",
        ecosystem_qualifier: qualifier,
        component: "openssl",
        affected: [{ introduced: "0", fixed }],
        fixed_versions: [fixed],
      }) as never;
    const d11 = doc("Debian:11", "1.1.1w-0+deb11u1");
    const d12 = doc("Debian:12", "3.0.11-1~deb12u2");
    const dep = (eco: string, version: string) => ({ ecosystem: eco, name: "openssl", version });
    expect(matchAdvisory(dep("Debian:12", "3.0.11-1~deb12u1"), d12)).toEqual({ affected: true, fixed_in: "3.0.11-1~deb12u2" });
    expect(matchAdvisory(dep("Debian:12", "3.0.11-1~deb12u2"), d12)).toEqual({ affected: false });
    // Cross-release negative: a Debian 12 version below the Debian 11 fix is not matched against the Debian 11 doc.
    expect(matchAdvisory(dep("Debian:12", "1.1.1n-0+deb11u5"), d11)).toEqual({ affected: false });
    expect(matchAdvisory(dep("Debian:11", "1.1.1n-0+deb11u5"), d11)).toEqual({ affected: true, fixed_in: "1.1.1w-0+deb11u1" });
    expect(matchAdvisory(dep("Debian", "1.1.1n-0+deb11u5"), d11).affected).toBe(false);
    expect(matchAdvisory(dep("Alpine:v3.18", "1.1.1n-0+deb11u5"), d11).affected).toBe(false);
  });
});

// 10 hand-built OSV records (tests/fixtures/osv/tcs-38/SOURCES.md: no Debian record could be recorded).
const RECORDS = assumed as unknown as OsvVuln[];

describe("Debian: 10 OSV records, one version inside and one outside each range", () => {
  it("matches each record through normalizeOsv and matchAdvisory, release by release", () => {
    expectRecordCases(RECORDS, ["Debian"], [
      { id: "TCS38-DEBIAN-01", dep: "Debian:12", name: "openssl", affected: "3.0.11-1~deb12u1", notAffected: "3.0.11-1~deb12u2", fixed_in: "3.0.11-1~deb12u2" },
      { id: "TCS38-DEBIAN-02", dep: "Debian:12", name: "audit", affected: "1:3.0.9-1", notAffected: "1:3.0.9-1+deb12u1", fixed_in: "1:3.0.9-1+deb12u1" },
      { id: "TCS38-DEBIAN-03", dep: "Debian:12", name: "libxml2", affected: "2.9.14+dfsg-1.2", notAffected: "2.9.14+dfsg-1.3", fixed_in: "2.9.14+dfsg-1.3~deb12u1" },
      { id: "TCS38-DEBIAN-04", dep: "Debian:12", name: "tcs38-epoch-fixture", affected: "2.9-1", notAffected: "1:2.3-4+deb12u1", fixed_in: "1:2.3-4+deb12u1" },
      { id: "TCS38-DEBIAN-05", dep: "Debian:12", name: "glibc", affected: "2.36-9+deb12u3", notAffected: "2.36-9+deb12u4", fixed_in: null },
      { id: "TCS38-DEBIAN-06", dep: "Debian:12", name: "base-files", affected: "12.4", notAffected: "12.4+deb12u2", fixed_in: "12.4+deb12u2" },
      { id: "TCS38-DEBIAN-07", dep: "Debian:12", name: "curl", affected: "7.88.1-10+deb12u4", notAffected: "7.88.1-9", fixed_in: "7.88.1-10+deb12u5" },
      { id: "TCS38-DEBIAN-08", dep: "Debian:13", name: "nginx", affected: "1.26.0-2", notAffected: "1.26.0-3", fixed_in: "1.26.0-3" },
      { id: "TCS38-DEBIAN-09", dep: "Debian:11", name: "sudo", affected: "1.9.5p2-3", notAffected: "1.9.5p2-3+deb11u1", fixed_in: "1.9.5p2-3+deb11u1" },
      { id: "TCS38-DEBIAN-10", dep: "Debian:11", name: "git", affected: "1:2.30.2-1+deb11u2", notAffected: "1:2.30.2-1+deb11u3", fixed_in: "1:2.30.2-1+deb11u3" },
    ]);
  });

  it("cross-release negative: a Debian:12 openssl at the Debian 11 fix sees only the Debian 12 range", () => {
    const docs = advisoriesOf(RECORDS.find((r) => r.id === "TCS38-DEBIAN-01")!, ["Debian"]);
    expect(docs.map((d) => d.ecosystem_qualifier)).toEqual(["Debian:11", "Debian:12"]);
    const dep = (eco: string) => ({ ecosystem: eco, name: "openssl", version: "1.1.1w-0+deb11u1" });
    // Debian 11: at its own fix, not affected by any doc.
    for (const a of docs) expect(matchAdvisory(dep("Debian:11"), a)).toEqual({ affected: false });
    // Debian 12: affected by the Debian 12 doc only.
    expect(docs.map((a) => matchAdvisory(dep("Debian:12"), a).affected)).toEqual([false, true]);
    // A Debian 13 dependency has no doc in this record.
    for (const a of docs) expect(matchAdvisory(dep("Debian:13"), a)).toEqual({ affected: false });
  });
});
