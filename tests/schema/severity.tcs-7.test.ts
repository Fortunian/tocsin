import { describe, expect, it } from "vitest";
import { labelFromScore as fromCvss } from "../../src/ingest/cvss";
import { labelFromScore } from "../../src/schema/severity";

describe("labelFromScore (src/schema/severity.ts)", () => {
  it.each([
    [9.0, "critical"],
    [7.0, "high"],
    [4.0, "medium"],
    [0.1, "low"],
    [0, "unknown"],
  ] as const)("boundary %s -> %s", (score, label) => {
    expect(labelFromScore(score)).toBe(label);
  });

  it.each([
    [10, "critical"],
    [9.2, "critical"],
    [8.9, "high"],
    [6.9, "medium"],
    [3.9, "low"],
  ] as const)("near miss %s -> %s", (score, label) => {
    expect(labelFromScore(score)).toBe(label);
  });

  it("src/ingest/cvss.ts re-exports the same function", () => {
    expect(fromCvss).toBe(labelFromScore);
  });
});
