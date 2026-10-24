import { describe, expect, it } from "vitest";
import { apkComparator } from "../../src/check/match/apk";
import { dpkgComparator } from "../../src/check/match/dpkg";
import { mavenComparator } from "../../src/check/match/maven";
import { nugetComparator } from "../../src/check/match/nuget";
import type { Comparator } from "../../src/check/match/types";
import alpineVectors from "../fixtures/versions/tcs-38/alpine_version_cmp.json";
import debVectors from "../fixtures/versions/tcs-38/deb_version_python_pkg_test.json";
import mavenVectors from "../fixtures/versions/tcs-38/maven_version_cmp.json";
import nugetVectors from "../fixtures/versions/tcs-38/nuget_version_cmp.json";

// TCS-38: recorded version-comparison vectors from univers 32.0.1 (PyPI),
// tests/data/schema/ (tests/fixtures/versions/tcs-38/SOURCES.md). Each
// "comparison" case lists two versions and their expected ascending order;
// each "equality" case says whether the two are equal.

interface Vector {
  test_type: "comparison" | "equality";
  input: { versions: string[] };
  expected_output: string[] | boolean;
}

function check(cmp: Comparator, vectors: Vector[]): string[] {
  const wrong: string[] = [];
  for (const v of vectors) {
    const [a, b] = v.input.versions;
    if (!cmp.valid(a) || !cmp.valid(b)) {
      wrong.push(`invalid: ${a} | ${b}`);
      continue;
    }
    const c = cmp.compare(a, b);
    if (v.test_type === "equality") {
      if ((c === 0) !== v.expected_output) wrong.push(`${a} == ${b} should be ${v.expected_output}`);
    } else {
      const [lo, hi] = v.expected_output as string[];
      const got = cmp.compare(lo, hi);
      if (lo === hi ? got !== 0 : got >= 0) wrong.push(`${lo} < ${hi} (compare ${a}, ${b} = ${c})`);
    }
  }
  return wrong;
}

describe("recorded version vectors (univers 32.0.1)", () => {
  it("Maven: 977 cases", () => {
    expect(mavenVectors).toHaveLength(977);
    expect(check(mavenComparator, mavenVectors as Vector[])).toEqual([]);
  });

  it("NuGet: 33 cases", () => {
    expect(nugetVectors).toHaveLength(33);
    expect(check(nugetComparator, nugetVectors as Vector[])).toEqual([]);
  });

  it("Alpine (apk): 716 cases", () => {
    expect(alpineVectors).toHaveLength(716);
    expect(check(apkComparator, alpineVectors as Vector[])).toEqual([]);
  });

  it("Debian (dpkg): 16 cases", () => {
    expect(debVectors).toHaveLength(16);
    expect(check(dpkgComparator, debVectors as Vector[])).toEqual([]);
  });
});
