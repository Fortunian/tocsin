import { describe, expect, it } from "vitest";
import { matchAdvisory, supportsEcosystem } from "../../src/check/match";
import { hexComparator } from "../../src/check/match/hex";
import type { OsvVuln } from "../../src/ingest/osv";
import assumed from "../fixtures/osv/tcs-38/hex.assumed.json";
import { expectAscending, expectInvalid, expectRecordCases } from "./ecosystem-cases.tcs-38";

// TCS-38: Hex uses Elixir's Version: strict SemVer 2 (three parts), pre-release order, build ignored.

describe("Hex comparator", () => {
  it("orders strict SemVer 2", () => {
    expectAscending(hexComparator, [
      "0.1.0",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      ["1.0.0", "1.0.0+build.1"],
      "1.0.1",
      "1.10.0",
      "2.0.0",
    ]);
  });

  it("rejects non-strict versions", () => {
    expectInvalid(hexComparator, ["", " ", "v1.0.0", "=1.0.0", "1.0", "1", "1.0.0.0", "1.0.0-", "~> 1.0"]);
  });

  it("is registered as Hex, exact name", () => {
    expect(supportsEcosystem("Hex")).toBe(true);
    expect(supportsEcosystem("hex")).toBe(false);
    const adv = { id: "tcs_TCS38HEX000000000000000", ecosystem: "Hex", component: "plug", affected: [{ introduced: "1.0.0", last_affected: "1.3.4" }], fixed_versions: [] } as never;
    expect(matchAdvisory({ ecosystem: "Hex", name: "plug", version: "1.3.4" }, adv)).toEqual({ affected: true });
    expect(matchAdvisory({ ecosystem: "Hex", name: "plug", version: "1.3.5-rc.0" }, adv)).toEqual({ affected: false });
    expect(matchAdvisory({ ecosystem: "npm", name: "plug", version: "1.3.4" }, adv)).toEqual({ affected: false });
  });
});

// 10 hand-built OSV records (tests/fixtures/osv/tcs-38/SOURCES.md: no Hex record could be recorded).
describe("Hex: 10 OSV records, one version inside and one outside each range", () => {
  it("matches each record through normalizeOsv and matchAdvisory", () => {
    expectRecordCases(assumed as unknown as OsvVuln[], ["Hex"], [
      { id: "TCS38-HEX-01", dep: "Hex", name: "plug", affected: "1.3.5", notAffected: "1.3.6", fixed_in: "1.3.6" },
      { id: "TCS38-HEX-02", dep: "Hex", name: "phoenix", affected: "1.1.7", notAffected: "1.2.3", fixed_in: "1.1.8" },
      { id: "TCS38-HEX-03", dep: "Hex", name: "phoenix_live_view", affected: "0.17.7-rc.0", notAffected: "0.17.7", fixed_in: "0.17.7" },
      { id: "TCS38-HEX-04", dep: "Hex", name: "sweet_xml", affected: "0.7.3", notAffected: "0.7.4", fixed_in: null },
      { id: "TCS38-HEX-05", dep: "Hex", name: "hackney", affected: "1.10.0", notAffected: "1.18.2", fixed_in: "1.18.2" },
      { id: "TCS38-HEX-06", dep: "Hex", name: "cowboy", affected: "2.9.0", notAffected: "1.1.2", fixed_in: "2.10.0" },
      { id: "TCS38-HEX-07", dep: "Hex", name: "jose", affected: "1.11.8", notAffected: "1.11.10", fixed_in: "1.11.9" },
      { id: "TCS38-HEX-08", dep: "Hex", name: "ex_doc", affected: "0.27.3-rc.1", notAffected: "0.28.0+build.1", fixed_in: "0.28.0" },
      { id: "TCS38-HEX-09", dep: "Hex", name: "coherence", affected: "0.5.1", notAffected: "0.5.2", fixed_in: "0.5.2" },
      { id: "TCS38-HEX-10", dep: "Hex", name: "mint", affected: "1.4.0", notAffected: "1.0.0-rc.1", fixed_in: "1.4.1" },
    ]);
  });
});
