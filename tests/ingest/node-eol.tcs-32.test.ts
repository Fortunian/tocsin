import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { eolAdvisories, NODE_EOL_DEFAULTS } from "../../src/ingest/node-eol";
import { NODE_DIST_KEY } from "../../src/ingest/node-runtime-dist";
import { defaultRegistry, runIngesters, type SourceOutcome } from "../../src/ingest/registry";
import { validateAdvisory, type Advisory } from "../../src/schema/advisory";
import distIndex from "../fixtures/node-eol/index.json?raw";
import scheduleJson from "../fixtures/node-eol/schedule.json?raw";
import { createRuntimeFake } from "./runtime-fake.tcs-6";

// Node.js end-of-life lines (TCS-32). Fixtures: the nodejs/Release
// schedule.json and one dist index entry per release line, both recorded
// (tests/fixtures/node-eol/README.md). The clock is pinned to 2026-10-23.
const NOW = new Date("2026-10-23T01:00:00Z");
const SCHEDULE = JSON.parse(scheduleJson) as Record<string, { start: string; end: string }>;
const DIST = new Set((JSON.parse(distIndex) as { version: string }[]).map((e) => e.version));

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((() => {
    throw new Error("real network call in a node-eol test");
  }) as never);
});
afterAll(() => fetchSpy.mockRestore());

async function cron(): Promise<SourceOutcome> {
  const fake = createRuntimeFake({ [NODE_EOL_DEFAULTS.schedule_url]: scheduleJson, [NODE_EOL_DEFAULTS.dist_index_url]: distIndex });
  fetchSpy.mockImplementation(fake.fetch as never);
  await env.DB.prepare("UPDATE sources SET enabled = CASE WHEN id = 'node-eol' THEN 1 ELSE 0 END").run();
  try {
    const out = await runIngesters(env, defaultRegistry, () => NOW);
    expect(out.map((o) => o.source)).toEqual(["node-eol"]);
    return out[0];
  } finally {
    await env.DB.prepare("UPDATE sources SET enabled = 1").run();
  }
}

async function stored(): Promise<Map<string, Advisory>> {
  const { results } = await env.DB.prepare("SELECT s.source_id, a.doc_json FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'node-eol'").all<{ source_id: string; doc_json: string }>();
  return new Map(results.map((r) => [r.source_id, JSON.parse(r.doc_json) as Advisory]));
}

beforeEach(async () => {
  await env.CURSORS.delete(NODE_DIST_KEY);
});

describe("eolAdvisories (pure)", () => {
  const r = eolAdvisories(SCHEDULE, DIST, NOW);

  it("one advisory per line whose end is before now (18, 16, 0.12 and the ended odd lines), none for 22, 24, 26 or 27", () => {
    expect(r.errors).toEqual([]);
    const ids = r.docs.map((d) => d.sources[0].source_id);
    for (const id of ["eol-18", "eol-16", "eol-0.12", "eol-0.10", "eol-0.8", "eol-20", "eol-23", "eol-25", "eol-4"]) expect(ids).toContain(id);
    for (const id of ["eol-22", "eol-24", "eol-26", "eol-27"]) expect(ids).not.toContain(id);
    expect(ids).toHaveLength(Object.values(SCHEDULE).filter((l) => Date.parse(`${l.end}T00:00:00Z`) < NOW.getTime()).length);
  });

  it("the 18.x doc: introduced 18.0.0, last_affected the newest 18.x of the dist index, no fix, high, the action names the lowest supported LTS line", () => {
    const d = r.docs.find((x) => x.sources[0].source_id === "eol-18")!;
    expect(d.ecosystem).toBe("node");
    expect(d.component).toBe("node");
    expect(d.affected).toEqual([{ introduced: "18.0.0", last_affected: "18.20.8" }]);
    expect(d.fixed_versions).toEqual([]);
    expect(d.severity).toEqual({ label: "high" });
    expect(d.summary).toBe("Node.js 18.x is end of life (since 2025-04-30). It gets no security fixes.");
    expect(d.action).toBe("Upgrade node to 22.x or later.");
    expect(d.published_at).toBe("2025-04-30T00:00:00Z");
    expect(d.references).toEqual([NODE_EOL_DEFAULTS.schedule_url, "https://nodejs.org/en/about/previous-releases"]);
    expect(validateAdvisory({ ...d, id: "tcs_01JA0000000000000000000000" }).ok).toBe(true);
  });

  it("v0.12 maps to introduced 0.12.0 and the newest 0.12.x", () => {
    const d = r.docs.find((x) => x.sources[0].source_id === "eol-0.12")!;
    expect(d.affected).toEqual([{ introduced: "0.12.0", last_affected: "0.12.18" }]);
    expect(d.summary).toBe("Node.js 0.12.x is end of life (since 2016-12-31). It gets no security fixes.");
  });

  it("20.x is not end of life before 2026-04-30 and is after; an odd line before its end gets none", () => {
    const before = eolAdvisories(SCHEDULE, DIST, new Date("2026-04-29T00:00:00Z")).docs.map((d) => d.sources[0].source_id);
    expect(before).not.toContain("eol-20");
    expect(before).not.toContain("eol-25");
    expect(eolAdvisories(SCHEDULE, DIST, new Date("2026-05-01T00:00:00Z")).docs.map((d) => d.sources[0].source_id)).toContain("eol-20");
  });

  it("a line with no release in the dist index is an error, not a guessed range", () => {
    const without = new Set([...DIST].filter((v) => !v.startsWith("v18.")));
    const x = eolAdvisories(SCHEDULE, without, NOW);
    expect(x.docs.map((d) => d.sources[0].source_id)).not.toContain("eol-18");
    expect(x.errors.join("\n")).toContain("18.x");
  });
});

describe("node-eol through the registry", () => {
  it("stores one doc per ended line; a re-run is all unchanged", async () => {
    const o1 = await cron();
    expect(o1.status, JSON.stringify(o1)).toBe("ok");
    const docs = await stored();
    expect(docs.get("eol-18")?.affected).toEqual([{ introduced: "18.0.0", last_affected: "18.20.8" }]);
    expect(docs.has("eol-22")).toBe(false);
    const o2 = await cron();
    expect(o2.status).toBe("ok");
    if (o2.status !== "ok") return;
    expect(o2.result.upserted).toBe(0);
    expect(o2.result.unchanged).toBe(docs.size);
  });
});
