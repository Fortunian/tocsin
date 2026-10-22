import { describe, expect, it } from "vitest";
import { cvss3BaseScore, labelFromScore } from "../../src/ingest/cvss";

describe("cvss3BaseScore", () => {
  // Scores published by FIRST's CVSS v3.1 calculator for these vectors.
  it.each([
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1],
    ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 7.8],
    ["CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:N", 0],
    ["CVSS:3.0/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H", 9.9],
  ])("%s = %d", (vector, score) => {
    expect(cvss3BaseScore(vector)).toBe(score);
  });

  it("ignores temporal metrics after the base metrics", () => {
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:P/RL:O")).toBe(9.8);
  });

  it.each([
    "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
    "garbage",
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H",
    "CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    "CVSS:3.1/AV:N/AV:L/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
  ])("returns undefined for %s", (vector) => {
    expect(cvss3BaseScore(vector)).toBeUndefined();
  });
});

describe("labelFromScore (CVSS spec bands)", () => {
  it.each([
    [10, "critical"],
    [9.0, "critical"],
    [8.9, "high"],
    [7.0, "high"],
    [6.9, "medium"],
    [4.0, "medium"],
    [3.9, "low"],
    [0.1, "low"],
    [0, "unknown"],
  ] as const)("%d -> %s", (score, label) => {
    expect(labelFromScore(score)).toBe(label);
  });
});
