import { describe, expect, it } from "vitest";
import { isAffected, matchAdvisory } from "../../src/check/match/index";
import { comparePep440 } from "../../src/check/match/pep440";
import type { MatchResult } from "../../src/check/match/types";
import type { Advisory, AffectedRange } from "../../src/schema/advisory";
import fixture from "../fixtures/advisory/valid.json";

const nodeAdvisory = fixture as Advisory;

function advisory(ecosystem: string, component: string, affected: AffectedRange[], fixed_versions: string[] = []): Advisory {
  return { ...structuredClone(nodeAdvisory), ecosystem, component, affected, fixed_versions };
}

// One table row: dependency version, advisory ranges, expected result.
type Row = [version: string, ranges: AffectedRange[], expected: MatchResult];

function table(ecosystem: string, component: string, rows: Row[]) {
  it.each(rows)("%s in %j", (version, ranges, expected) => {
    const result = matchAdvisory({ ecosystem, name: component, version }, advisory(ecosystem, component, ranges));
    expect(result).toEqual(expected);
  });
}

const A = (fixed_in?: string): MatchResult => (fixed_in ? { affected: true, fixed_in } : { affected: true });
const NO: MatchResult = { affected: false };
const BAD_VERSION: MatchResult = { affected: false, skipped: "invalid_version" };

describe("range", () => {
  table("npm", "left-pad", [
    ["0.0.1", [{ introduced: "0", fixed: "1.0.0" }], A("1.0.0")],
    ["1.0.0", [{ introduced: "0", fixed: "1.0.0" }], NO],
    ["1.2.0", [{ introduced: "1.0.0", last_affected: "1.2.0" }], A()],
    ["1.2.1", [{ introduced: "1.0.0", last_affected: "1.2.0" }], NO],
    ["0.9.9", [{ introduced: "1.0.0", last_affected: "1.2.0" }], NO],
    ["1.0.0", [{ introduced: "1.0.0", last_affected: "1.2.0" }], A()],
    ["99.0.0", [{ introduced: "2.0.0" }], A()],
    ["1.9.9", [{ introduced: "2.0.0" }], NO],
    ["0.5.0", [{ fixed: "1.0.0" }], A("1.0.0")],
    ["0.5.0", [], NO],
  ]);
});

describe("node 2026-10-21", () => {
  const check = (version: string) => matchAdvisory({ ecosystem: "node", name: "node", version }, nodeAdvisory);
  it.each<[string, MatchResult]>([
    ["24.22.0", A("24.22.1")],
    ["24.0.0", A("24.22.1")],
    ["24.22.1", NO],
    ["26.0.0", A("26.12.1")],
    ["26.12.0", A("26.12.1")],
    ["26.12.1", NO],
    ["22.23.3", A("22.23.4")],
    ["23.0.0", NO],
    ["23.9.0", NO],
    ["v24.22.0", A("24.22.1")],
    ["24.22.1-rc.1", A("24.22.1")],
    ["27.0.0", NO],
  ])("%s", (version, expected) => {
    expect(check(version)).toEqual(expected);
  });
});

describe("npm", () => {
  table("npm", "lodash", [
    ["1.0.0-alpha", [{ introduced: "0", fixed: "1.0.0-beta" }], A("1.0.0-beta")],
    ["1.0.0-beta", [{ introduced: "0", fixed: "1.0.0-beta" }], NO],
    ["1.0.0-beta", [{ introduced: "0", fixed: "1.0.0" }], A("1.0.0")],
    ["1.0.0", [{ introduced: "1.0.0-alpha", fixed: "1.0.0" }], NO],
    ["0.0.0", [{ introduced: "0", fixed: "4.17.21" }], A("4.17.21")],
    ["4.17.20", [{ introduced: "0", fixed: "4.17.21" }], A("4.17.21")],
    ["4.17.21", [{ introduced: "0", fixed: "4.17.21" }], NO],
    ["4.17.22", [{ introduced: "4.0.0", last_affected: "4.17.21" }], NO],
    ["4.17.21", [{ introduced: "4.0.0", last_affected: "4.17.21" }], A()],
    ["3.10.1", [{ introduced: "4.0.0", fixed: "4.17.21" }], NO],
    ["1.2.3+build.5", [{ introduced: "0", fixed: "1.2.4" }], A("1.2.4")],
    ["latest", [{ introduced: "0", fixed: "1.0.0" }], BAD_VERSION],
  ]);
});

describe("deno", () => {
  table("deno", "deno", [
    ["2.1.0", [{ introduced: "2.0.0", fixed: "2.1.5" }], A("2.1.5")],
    ["2.1.5", [{ introduced: "2.0.0", fixed: "2.1.5" }], NO],
  ]);
});

describe("bun", () => {
  table("bun", "bun", [
    ["1.1.0-canary.1", [{ introduced: "0", fixed: "1.1.0" }], A("1.1.0")],
    ["1.1.0", [{ introduced: "0", fixed: "1.1.0" }], NO],
  ]);
});

describe("PyPI ordering", () => {
  it.each<[string, string, number]>([
    ["1.0.post1", "1.0", 1],
    ["1.0rc1", "1.0", -1],
    ["1.0.dev1", "1.0a1", -1],
    ["1.0a1", "1.0b1", -1],
    ["1.0b1", "1.0rc1", -1],
    ["1!1.0", "2.0", 1],
    ["1.0", "1.0.0", 0],
    ["1.0+local", "1.0", 1],
    ["1.0alpha1", "1.0a1", 0],
    ["1.0c1", "1.0rc1", 0],
    ["1.0-1", "1.0.post1", 0],
    ["1.0.post1.dev1", "1.0.post1", -1],
    ["1.0rc1", "1.0.post1", -1],
    ["2024.1", "2023.12", 1],
    ["1.0+abc.5", "1.0+abc.10", -1],
    ["1.0+5", "1.0+abc", 1],
  ])("%s vs %s", (a, b, expected) => {
    expect(comparePep440(a, b)).toBe(expected);
    expect(comparePep440(b, a)).toBe(-expected || 0);
  });
});

describe("PyPI", () => {
  table("PyPI", "requests", [
    ["1.0.post1", [{ introduced: "0", fixed: "1.0.post1" }], NO],
    ["1.0", [{ introduced: "0", fixed: "1.0.post1" }], A("1.0.post1")],
    ["1.0rc1", [{ introduced: "0", fixed: "1.0" }], A("1.0")],
    ["1.0", [{ introduced: "0", fixed: "1.0" }], NO],
    ["2024.1", [{ introduced: "2023.0", fixed: "2024.2" }], A("2024.2")],
    ["2024.2", [{ introduced: "2023.0", fixed: "2024.2" }], NO],
    ["1!1.0", [{ introduced: "0", fixed: "2.0" }], NO],
    ["1.0.0", [{ introduced: "1.0", last_affected: "1.0" }], A()],
    ["1.0.1", [{ introduced: "1.0", last_affected: "1.0" }], NO],
    ["1.0.dev1", [{ introduced: "1.0a1", fixed: "1.1" }], NO],
    ["1.0+local", [{ introduced: "0", last_affected: "1.0" }], NO],
    ["latest", [{ introduced: "0", fixed: "1.0" }], BAD_VERSION],
    ["1.0-foo", [{ introduced: "0", fixed: "1.0" }], BAD_VERSION],
  ]);

  it("normalizes names on both sides (PEP 503)", () => {
    const adv = advisory("PyPI", "requests", [{ introduced: "0", fixed: "2.0" }]);
    expect(isAffected({ ecosystem: "PyPI", name: "Requests", version: "1.0" }, adv)).toBe(true);
    const zope = advisory("PyPI", "zope.interface", [{ introduced: "0", fixed: "2.0" }]);
    expect(isAffected({ ecosystem: "PyPI", name: "zope-interface", version: "1.0" }, zope)).toBe(true);
    expect(isAffected({ ecosystem: "PyPI", name: "Zope__Interface", version: "1.0" }, zope)).toBe(true);
    expect(isAffected({ ecosystem: "PyPI", name: "zopeinterface", version: "1.0" }, zope)).toBe(false);
  });
});

describe("python", () => {
  table("python", "python", [
    ["3.12.1", [{ introduced: "3.12.0", fixed: "3.12.4" }], A("3.12.4")],
    ["3.12.4", [{ introduced: "3.12.0", fixed: "3.12.4" }], NO],
    ["3.13.0rc2", [{ introduced: "3.13.0a1", fixed: "3.13.0" }], A("3.13.0")],
    ["3.11.9", [{ introduced: "3.12.0", fixed: "3.12.4" }], NO],
  ]);
});

describe("Packagist", () => {
  table("Packagist", "laravel/framework", [
    ["v1.2.3", [{ introduced: "1.2.3", fixed: "1.2.4" }], A("1.2.4")],
    ["1.2.3", [{ introduced: "0", fixed: "v1.2.3" }], NO],
    ["1.2.3.4", [{ introduced: "0", fixed: "1.2.3" }], NO],
    ["1.2.3.4", [{ introduced: "0", fixed: "1.2.3.5" }], A("1.2.3.5")],
    ["1.2.3.0", [{ introduced: "0", last_affected: "1.2.3" }], A()],
    ["1.2.3.1", [{ introduced: "0", last_affected: "1.2.3" }], NO],
    ["1.0.0-RC1", [{ introduced: "0", fixed: "1.0.0" }], A("1.0.0")],
    ["1.0.0-beta2", [{ introduced: "0", fixed: "1.0.0-RC1" }], A("1.0.0-RC1")],
    ["1.0.0-alpha3", [{ introduced: "1.0.0-beta1", fixed: "1.0.0" }], NO],
    ["1.0.0-p1", [{ introduced: "0", fixed: "1.0.0" }], NO],
    ["1.0.0", [{ introduced: "0", fixed: "1.0.0-p1" }], A("1.0.0-p1")],
    ["1.0.0-dev", [{ introduced: "1.0.0-alpha1", fixed: "1.1.0" }], NO],
    ["1.0", [{ introduced: "1.0.0", fixed: "1.0.1" }], A("1.0.1")],
    ["dev-main", [{ introduced: "0", fixed: "2.0.0" }], BAD_VERSION],
  ]);
});

describe("php", () => {
  table("php", "php", [
    ["8.4.26", [{ introduced: "8.4.0", fixed: "8.4.27" }], A("8.4.27")],
    ["8.4.27", [{ introduced: "8.4.0", fixed: "8.4.27" }], NO],
    ["8.3.12", [{ introduced: "8.4.0", fixed: "8.4.27" }], NO],
    ["8.5.0RC2", [{ introduced: "8.5.0alpha1", fixed: "8.5.0" }], A("8.5.0")],
  ]);
});

describe("Go", () => {
  table("Go", "golang.org/x/net", [
    ["v0.0.0-20210101000000-abcdefabcdef", [{ introduced: "0", fixed: "v0.0.0-20220101000000-123456789abc" }], A("v0.0.0-20220101000000-123456789abc")],
    ["v0.0.0-20230101000000-abcdefabcdef", [{ introduced: "0", fixed: "v0.0.0-20220101000000-123456789abc" }], NO],
    ["v0.0.0-20220101000000-123456789abc", [{ introduced: "0", fixed: "v0.0.0-20220101000000-123456789abc" }], NO],
    ["v0.17.0", [{ introduced: "0", fixed: "v0.17.0" }], NO],
    ["v0.16.9", [{ introduced: "0", fixed: "v0.17.0" }], A("v0.17.0")],
    ["v0.17.0-0.20230101000000-abcdefabcdef", [{ introduced: "0", fixed: "v0.17.0" }], A("v0.17.0")],
    ["v0.17.1-0.20230101000000-abcdefabcdef", [{ introduced: "0", fixed: "v0.17.0" }], NO],
    ["v0.17.0-rc.1.0.20230101000000-abcdefabcdef", [{ introduced: "v0.17.0-rc.1", fixed: "v0.17.0" }], A("v0.17.0")],
    ["v2.0.0+incompatible", [{ introduced: "v2.0.0", last_affected: "v2.0.0" }], A()],
    ["v2.0.1+incompatible", [{ introduced: "v2.0.0", last_affected: "v2.0.0" }], NO],
    ["v1.5.0", [{ introduced: "v1.0.0" }], A()],
    ["1.5.0", [{ introduced: "v1.0.0" }], BAD_VERSION],
  ]);
});

describe("go runtime", () => {
  table("go", "go", [
    ["go1.22.3", [{ introduced: "1.22.0", fixed: "1.22.4" }], A("1.22.4")],
    ["1.22.4", [{ introduced: "1.22.0", fixed: "1.22.4" }], NO],
    ["1.21rc2", [{ introduced: "0", fixed: "1.21.0" }], A("1.21.0")],
    ["1.21", [{ introduced: "0", fixed: "1.21.0" }], NO],
    ["1.21.0-rc.2", [{ introduced: "1.21.0-rc.1", fixed: "1.21.0" }], A("1.21.0")],
  ]);

  it("a go runtime dep never matches a Go module advisory", () => {
    const mod = advisory("Go", "go", [{ introduced: "0", fixed: "v9.0.0" }]);
    expect(matchAdvisory({ ecosystem: "go", name: "go", version: "1.22.0" }, mod)).toEqual(NO);
  });
});

describe("crates.io", () => {
  table("crates.io", "tokio", [
    ["1.0.0-alpha", [{ introduced: "0", fixed: "1.0.0-beta" }], A("1.0.0-beta")],
    ["1.0.0-beta", [{ introduced: "0", fixed: "1.0.0-beta" }], NO],
    ["1.0.0-rc.1", [{ introduced: "0", fixed: "1.0.0" }], A("1.0.0")],
    ["1.38.0", [{ introduced: "1.30.0", fixed: "1.38.1" }], A("1.38.1")],
    ["1.38.1", [{ introduced: "1.30.0", fixed: "1.38.1" }], NO],
    ["1.29.9", [{ introduced: "1.30.0", fixed: "1.38.1" }], NO],
    ["0.2.25", [{ introduced: "0.2.0", last_affected: "0.2.25" }], A()],
    ["0.2.26", [{ introduced: "0.2.0", last_affected: "0.2.25" }], NO],
    ["2.0.0", [{ introduced: "1.0.0" }], A()],
    ["0.0.1", [{ introduced: "0", fixed: "0.0.2" }], A("0.0.2")],
    ["v1.0.0", [{ introduced: "0", fixed: "2.0.0" }], BAD_VERSION],
    ["1.0", [{ introduced: "0", fixed: "2.0.0" }], BAD_VERSION],
  ]);
});

describe("RubyGems", () => {
  table("RubyGems", "rails", [
    ["1.0", [{ introduced: "0", fixed: "1.0.0" }], NO],
    ["1.0.0", [{ introduced: "0", last_affected: "1.0" }], A()],
    ["1.9", [{ introduced: "0", fixed: "1.10" }], A("1.10")],
    ["1.10", [{ introduced: "0", fixed: "1.9" }], NO],
    ["1.0.0.pre1", [{ introduced: "0", fixed: "1.0.0" }], A("1.0.0")],
    ["1.0.0-rc1", [{ introduced: "0", fixed: "1.0.0" }], A("1.0.0")],
    // `-rc1` reads as `.pre.rc1`, so it sorts below `1.0.0.q` ("pre" < "q").
    ["1.0.0-rc1", [{ introduced: "1.0.0.q", fixed: "1.0.0" }], NO],
    ["1.0.a", [{ introduced: "0", fixed: "1.0.b" }], A("1.0.b")],
    ["1.0.b", [{ introduced: "0", fixed: "1.0.a" }], NO],
    ["7.1.3.4", [{ introduced: "7.1.0", fixed: "7.1.3.5" }], A("7.1.3.5")],
    ["7.0.8", [{ introduced: "7.1.0", fixed: "7.1.3.5" }], NO],
    ["7.1.0.rc1", [{ introduced: "7.1.0", fixed: "7.1.3.5" }], NO],
    ["not a version!", [{ introduced: "0", fixed: "1.0" }], BAD_VERSION],
  ]);
});

describe("dispatch", () => {
  const adv = advisory("npm", "requests", [{ introduced: "0", fixed: "2.0.0" }], ["2.0.0", "1.5.0"]);

  it("name mismatch is not affected and not skipped", () => {
    expect(matchAdvisory({ ecosystem: "npm", name: "other", version: "1.0.0" }, adv)).toEqual(NO);
  });

  it("same name in another ecosystem is not affected", () => {
    expect(matchAdvisory({ ecosystem: "PyPI", name: "requests", version: "1.0.0" }, adv)).toEqual(NO);
  });

  it("an unsupported ecosystem is skipped, never a clean false", () => {
    const maven = advisory("Maven", "org.foo:bar", [{ introduced: "0", fixed: "2.0.0" }]);
    expect(matchAdvisory({ ecosystem: "Maven", name: "org.foo:bar", version: "1.0.0" }, maven)).toEqual({
      affected: false,
      skipped: "unsupported_ecosystem",
    });
  });

  it("an unparseable dependency version is skipped", () => {
    expect(matchAdvisory({ ecosystem: "npm", name: "requests", version: "not-a-version" }, adv)).toEqual(BAD_VERSION);
  });

  it("fixed_in is the lowest candidate above the version from ranges and fixed_versions", () => {
    expect(matchAdvisory({ ecosystem: "npm", name: "requests", version: "1.0.0" }, adv)).toEqual(A("1.5.0"));
    expect(matchAdvisory({ ecosystem: "npm", name: "requests", version: "1.5.0" }, adv)).toEqual(A("2.0.0"));
  });

  it("fixed_in is omitted when no candidate is above the version", () => {
    const only = advisory("npm", "x", [{ introduced: "0", last_affected: "3.0.0" }], ["1.0.0"]);
    expect(matchAdvisory({ ecosystem: "npm", name: "x", version: "2.0.0" }, only)).toEqual(A());
  });

  it("isAffected returns the same boolean as matchAdvisory", () => {
    for (const version of ["1.0.0", "2.0.0", "junk"]) {
      const dep = { ecosystem: "npm", name: "requests", version };
      expect(isAffected(dep, adv)).toBe(matchAdvisory(dep, adv).affected);
    }
    expect(isAffected({ ecosystem: "npm", name: "requests", version: "1.0.0" }, adv)).toBe(true);
    expect(isAffected({ ecosystem: "npm", name: "requests", version: "2.0.0" }, adv)).toBe(false);
  });

  it("a range with a bad bound and no other match is skipped as invalid_range", () => {
    const bad = advisory("npm", "x", [{ introduced: "0", fixed: "garbage" }]);
    expect(matchAdvisory({ ecosystem: "npm", name: "x", version: "1.0.0" }, bad)).toEqual({
      affected: false,
      skipped: "invalid_range",
    });
  });

  it("a bad bound next to a matching good range is still affected", () => {
    const mixed = advisory("npm", "x", [{ introduced: "0", fixed: "garbage" }, { introduced: "0", fixed: "2.0.0" }]);
    expect(matchAdvisory({ ecosystem: "npm", name: "x", version: "1.0.0" }, mixed)).toEqual(A("2.0.0"));
  });
});
