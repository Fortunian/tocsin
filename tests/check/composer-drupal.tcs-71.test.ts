import { describe, expect, it } from "vitest";
import { compareComposer, composerComparator, parseComposer } from "../../src/check/match/composer";

// TCS-71: Drupal contrib releases use the legacy form <core>.x-<version>
// (8.x-1.0). The packages.drupal.org/8 Composer facade maps it to <version>,
// so the comparator reads 8.x-1.0 as 1.0.

describe("Composer comparator, Drupal legacy versions", () => {
  it("8.x-1.0 reads as 1.0", () => {
    expect(parseComposer("8.x-1.0")).not.toBeNull();
    expect(parseComposer("8.x-1.0")).toEqual(parseComposer("1.0"));
    expect(parseComposer("7.x-2.3-beta1")).toEqual(parseComposer("2.3-beta1"));
  });

  it("8.x-1.34 sorts below 1.35.0; 8.x-1.35 equals it", () => {
    expect(compareComposer("8.x-1.34", "1.35.0")).toBe(-1);
    expect(compareComposer("8.x-1.35", "1.35.0")).toBe(0);
    expect(compareComposer("8.x-1.36", "1.35.0")).toBe(1);
  });

  it("other version strings keep their old results", () => {
    expect(parseComposer("1.0.0")).toEqual({ parts: [1, 0, 0, 0], stability: 4, stabilityNums: [], dev: false });
    expect(parseComposer("v1.2")).toEqual({ parts: [1, 2, 0, 0], stability: 4, stabilityNums: [], dev: false });
    expect(parseComposer("1.0-beta2")).toEqual({ parts: [1, 0, 0, 0], stability: 2, stabilityNums: [2], dev: false });
    expect(composerComparator.valid("dev-main")).toBe(false);
    expect(composerComparator.valid("8.x-dev")).toBe(false);
    expect(composerComparator.valid("8.x-")).toBe(false);
  });
});
