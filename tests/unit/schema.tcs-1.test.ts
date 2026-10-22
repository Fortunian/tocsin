import { describe, expect, it } from "vitest";
import { validateAdvisory } from "../../src/schema/advisory";
import fixture from "../fixtures/advisory/valid.json";

function copy(): Record<string, unknown> {
  return structuredClone(fixture) as Record<string, unknown>;
}

function errorsOf(x: unknown): string[] {
  const r = validateAdvisory(x);
  if (r.ok) throw new Error("expected validation to fail");
  return r.errors;
}

describe("validateAdvisory (advisory schema v1)", () => {
  it("accepts the fixture advisory", () => {
    const r = validateAdvisory(copy());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ecosystem).toBe("node");
  });

  it("rejects a record missing ecosystem and names the field", () => {
    const a = copy();
    delete a.ecosystem;
    expect(errorsOf(a).join("\n")).toContain("ecosystem");
  });

  it("rejects a summary over 200 chars and accepts exactly 200", () => {
    const long = copy();
    long.summary = "x".repeat(201);
    expect(errorsOf(long).some((e) => e.startsWith("/summary"))).toBe(true);

    const edge = copy();
    edge.summary = "x".repeat(200);
    expect(validateAdvisory(edge).ok).toBe(true);
  });

  it("rejects an action over 200 chars", () => {
    const a = copy();
    a.action = "y".repeat(201);
    expect(errorsOf(a).some((e) => e.startsWith("/action"))).toBe(true);
  });

  it("rejects a multi-line summary", () => {
    const a = copy();
    a.summary = "line one\nline two";
    expect(errorsOf(a).some((e) => e.startsWith("/summary"))).toBe(true);
  });

  it("rejects an unknown severity label", () => {
    const a = copy();
    a.severity = { score: 8.1, label: "severe" };
    expect(errorsOf(a).some((e) => e.startsWith("/severity/label"))).toBe(true);
  });

  it("rejects epss outside 0..1", () => {
    const a = copy();
    a.epss = 1.5;
    expect(errorsOf(a).some((e) => e.startsWith("/epss"))).toBe(true);
  });

  it("rejects an id that is not tcs_ + ulid", () => {
    const a = copy();
    a.id = "tcs_123";
    expect(errorsOf(a).some((e) => e.startsWith("/id"))).toBe(true);
  });

  it("rejects an unknown top-level field", () => {
    const a = copy();
    a.extra = 1;
    expect(errorsOf(a).join("\n")).toContain("extra");
  });

  it("rejects a source entry without url", () => {
    const a = copy();
    a.sources = [{ source: "osv", source_id: "GHSA-fixture" }];
    expect(errorsOf(a).join("\n")).toContain("url");
  });
});
