import { describe, expect, it } from "vitest";
import { matchAdvisory, supportsEcosystem } from "../../src/check/match";
import { nugetComparator } from "../../src/check/match/nuget";
import type { OsvVuln } from "../../src/ingest/osv";
import rh7jm from "../fixtures/osv/tcs-38/NuGet/GHSA-h7jm-g87p-5935.json";
import assumed from "../fixtures/osv/tcs-38/nuget.assumed.json";
import { expectAscending, expectInvalid, expectRecordCases } from "./ecosystem-cases.tcs-38";

// TCS-38: NuGet versions are SemVer 2 with 1 to 4 numeric parts (missing parts
// are 0). Pre-release labels compare case-insensitive, numeric labels as
// numbers and below text labels. Build metadata (+...) does not count.

describe("NuGet comparator", () => {
  it("orders 4-part, pre-release and build versions", () => {
    expectAscending(nugetComparator, [
      "0.9.9.9",
      "1.0.0-1",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      ["1.0.0-Beta", "1.0.0-beta", "1.0.0-BETA+sha.1"],
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      ["1.0.0", "1.0", "1", "1.0.0.0", "1.0.0+build.5"],
      "1.0.0.1",
      "1.0.1",
      "1.2.3",
      ["1.2.3.4", "1.2.3.4+x"],
      "1.2.3.10",
      "1.10",
      "13.0.1",
    ]);
  });

  it("rejects what NuGet does not parse", () => {
    expectInvalid(nugetComparator, ["", " ", "v1.0.0", "1.2.3.4.5", "1.0.0-", "1.0.0-beta..1", "abc", "1.a"]);
  });

  it("is registered as NuGet, exact name", () => {
    expect(supportsEcosystem("NuGet")).toBe(true);
    expect(supportsEcosystem("nuget")).toBe(false);
    expect(supportsEcosystem("NuGet:x")).toBe(false);
    const adv = {
      id: "tcs_TCS38NUGET0000000000000",
      ecosystem: "NuGet",
      component: "Newtonsoft.Json",
      affected: [{ introduced: "0", fixed: "13.0.1" }],
      fixed_versions: ["13.0.1"],
    } as never;
    expect(matchAdvisory({ ecosystem: "NuGet", name: "Newtonsoft.Json", version: "12.0.3.0" }, adv)).toEqual({ affected: true, fixed_in: "13.0.1" });
    expect(matchAdvisory({ ecosystem: "NuGet", name: "Newtonsoft.Json", version: "13.0.1.0" }, adv)).toEqual({ affected: false });
    // Negative: an npm dependency of the same name, and another case of the name (A6: exact case).
    expect(matchAdvisory({ ecosystem: "npm", name: "Newtonsoft.Json", version: "12.0.3" }, adv)).toEqual({ affected: false });
    expect(matchAdvisory({ ecosystem: "NuGet", name: "newtonsoft.json", version: "12.0.3" }, adv)).toEqual({ affected: false });
  });
});

// 10 OSV records (tests/fixtures/osv/tcs-38/SOURCES.md): 1 recorded GHSA copy, 9 hand-built.
const RECORDS = [rh7jm, ...assumed] as unknown as OsvVuln[];

describe("NuGet: 10 OSV records, one version inside and one outside each range", () => {
  it("matches each record through normalizeOsv and matchAdvisory", () => {
    expectRecordCases(RECORDS, ["NuGet"], [
      { id: "GHSA-h7jm-g87p-5935", dep: "NuGet", name: "Microsoft.NETCore.App.Runtime.win-x64", affected: "7.0.10", notAffected: "6.0.22", fixed_in: "7.0.11" },
      { id: "TCS38-NUGET-01", dep: "NuGet", name: "Newtonsoft.Json", affected: "12.0.3", notAffected: "13.0.1", fixed_in: "13.0.1" },
      { id: "TCS38-NUGET-02", dep: "NuGet", name: "System.Text.Encodings.Web", affected: "4.5.0", notAffected: "4.7.2", fixed_in: "4.5.1" },
      { id: "TCS38-NUGET-03", dep: "NuGet", name: "RestSharp", affected: "106.11.7", notAffected: "106.11.8-alpha.0.14", fixed_in: "106.11.8-alpha.0.13" },
      { id: "TCS38-NUGET-04", dep: "NuGet", name: "System.Net.Http", affected: "4.3.3.0", notAffected: "4.3.4.0", fixed_in: "4.3.4" },
      { id: "TCS38-NUGET-05", dep: "NuGet", name: "Microsoft.Data.SqlClient", affected: "5.1.2", notAffected: "4.0.5", fixed_in: "5.1.3" },
      { id: "TCS38-NUGET-06", dep: "NuGet", name: "SharpZipLib", affected: "1.3.2", notAffected: "1.3.3", fixed_in: null },
      { id: "TCS38-NUGET-07", dep: "NuGet", name: "log4net", affected: "2.0.10-RC1", notAffected: "2.0.10", fixed_in: "2.0.10" },
      { id: "TCS38-NUGET-08", dep: "NuGet", name: "YamlDotNet", affected: "4.3.2", notAffected: "5.0.0+build.7", fixed_in: "5.0.0" },
      { id: "TCS38-NUGET-09", dep: "NuGet", name: "MessagePack", affected: "1.9.3", notAffected: "2.0.0-beta", fixed_in: "1.9.11" },
    ]);
  });
});
