import { describe, expect, it } from "vitest";
import { matchAdvisory, supportsEcosystem } from "../../src/check/match";
import { pubComparator } from "../../src/check/match/pub";
import type { OsvVuln } from "../../src/ingest/osv";
import assumed from "../fixtures/osv/tcs-38/pub.assumed.json";
import { expectAscending, expectInvalid, expectRecordCases } from "./ecosystem-cases.tcs-38";

// TCS-38: Pub uses Dart's pub_semver: SemVer 2 precedence, and build metadata
// breaks a tie (1.2.3+1 > 1.2.3), compared like a pre-release list.

describe("Pub comparator", () => {
  it("orders SemVer 2 with the build tie-break", () => {
    expectAscending(pubComparator, [
      "0.0.1",
      "1.0.0-dev",
      "1.0.0-dev.2",
      "1.0.0-nullsafety.0",
      "1.0.0",
      "1.0.0+1",
      "1.0.0+2",
      "1.0.0+10",
      "1.0.0+a",
      "1.0.1",
      "1.2.3",
      "1.2.3+1",
      "2.0.0",
    ]);
  });

  it("rejects non-strict versions", () => {
    expectInvalid(pubComparator, ["", " ", "v1.0.0", "1.0", "1.0.0.0", "^1.0.0", "1.0.0+"]);
  });

  it("is registered as Pub, exact name", () => {
    expect(supportsEcosystem("Pub")).toBe(true);
    expect(supportsEcosystem("pub")).toBe(false);
    const adv = { id: "tcs_TCS38PUB000000000000000", ecosystem: "Pub", component: "http", affected: [{ introduced: "0", fixed: "1.2.3+1" }], fixed_versions: ["1.2.3+1"] } as never;
    expect(matchAdvisory({ ecosystem: "Pub", name: "http", version: "1.2.3" }, adv)).toEqual({ affected: true, fixed_in: "1.2.3+1" });
    expect(matchAdvisory({ ecosystem: "Pub", name: "http", version: "1.2.3+1" }, adv)).toEqual({ affected: false });
    expect(matchAdvisory({ ecosystem: "npm", name: "http", version: "1.0.0" }, adv)).toEqual({ affected: false });
  });
});

// 10 hand-built OSV records (tests/fixtures/osv/tcs-38/SOURCES.md: no Pub record could be recorded).
describe("Pub: 10 OSV records, one version inside and one outside each range", () => {
  it("matches each record through normalizeOsv and matchAdvisory", () => {
    expectRecordCases(assumed as unknown as OsvVuln[], ["Pub"], [
      { id: "TCS38-PUB-01", dep: "Pub", name: "http", affected: "0.13.2", notAffected: "0.13.3", fixed_in: "0.13.3" },
      { id: "TCS38-PUB-02", dep: "Pub", name: "dio", affected: "5.0.0", notAffected: "5.0.0+1", fixed_in: "5.0.0+1" },
      { id: "TCS38-PUB-03", dep: "Pub", name: "flutter_secure_storage", affected: "4.2.1", notAffected: "4.2.1+1", fixed_in: null },
      { id: "TCS38-PUB-04", dep: "Pub", name: "provider", affected: "6.0.0-nullsafety.4", notAffected: "6.0.0", fixed_in: "6.0.0" },
      { id: "TCS38-PUB-05", dep: "Pub", name: "shelf", affected: "1.0.0", notAffected: "1.1.1", fixed_in: "1.1.1" },
      { id: "TCS38-PUB-06", dep: "Pub", name: "path_provider", affected: "2.0.10", notAffected: "1.6.28", fixed_in: "2.0.11" },
      { id: "TCS38-PUB-07", dep: "Pub", name: "crypto", affected: "3.0.1", notAffected: "3.0.2", fixed_in: "3.0.2" },
      { id: "TCS38-PUB-08", dep: "Pub", name: "url_launcher", affected: "5.7.10", notAffected: "6.1.12", fixed_in: "5.7.11" },
      { id: "TCS38-PUB-09", dep: "Pub", name: "webview_flutter", affected: "3.0.4", notAffected: "4.0.0", fixed_in: "4.0.0" },
      { id: "TCS38-PUB-10", dep: "Pub", name: "sqflite", affected: "2.2.8+3", notAffected: "2.0.0+2", fixed_in: "2.2.8+4" },
    ]);
  });
});
