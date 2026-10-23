import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PY_DEFAULTS, PY_ETAG_KEY, PY_RETRYING_SQL } from "../../src/ingest/python-runtime";
import { defaultRegistry, runIngesters, type SourceOutcome } from "../../src/ingest/registry";
import { createPyFake } from "./python-fake.tcs-39";

// python-runtime coverage (TCS-32): the PSF listing is the whole history, so a
// complete run with no error and no record still retrying sets coverage_since.
// The listings here are SYNTHETIC: an empty one and one cut at the 1000-entry limit.
const SOURCE = "python-runtime";
const NOW = new Date("2026-10-23T01:00:00Z");

let fetchSpy: MockInstance;
beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((() => {
    throw new Error("real network call in a python-runtime-coverage test");
  }) as never);
});
afterAll(() => fetchSpy.mockRestore());

async function runPython(listing: string): Promise<SourceOutcome> {
  fetchSpy.mockImplementation(createPyFake({ [PY_DEFAULTS.listing_url]: listing }).fetch as never);
  await env.DB.prepare("UPDATE sources SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END").bind(SOURCE).run();
  try {
    return (await runIngesters(env, defaultRegistry, () => NOW))[0];
  } finally {
    await env.DB.prepare("UPDATE sources SET enabled = 1").run();
  }
}

const coverage = async () => (await env.DB.prepare("SELECT coverage_since FROM sources WHERE id = ?").bind(SOURCE).first<{ coverage_since: string | null }>())!.coverage_since;

beforeEach(async () => {
  await env.DB.prepare("UPDATE sources SET coverage_since = NULL WHERE id = ?").bind(SOURCE).run();
  await env.DB.prepare("DELETE FROM python_runtime_records").run();
  await env.CURSORS.delete(PY_ETAG_KEY);
});

describe("python-runtime coverage", () => {
  it("a complete run sets coverage_since (the run time when it holds no advisory)", async () => {
    const o = await runPython("[]");
    expect(o.status, JSON.stringify(o)).toBe("ok");
    expect(await coverage()).toBe(NOW.toISOString());
  });

  it("a listing cut at the entry limit is an error and sets nothing", async () => {
    const cut = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ name: `README-${i}.txt`, type: "file" })));
    const o = await runPython(cut);
    expect(o.status).toBe("failed");
    expect(await coverage()).toBeNull();
  });

  it("a record still retrying holds coverage_since back", async () => {
    await env.DB.prepare("INSERT INTO python_runtime_records (psf_id, state, attempts, next_check_at, updated_at) VALUES ('PSF-2099-1', 'failed', 1, '2099-01-01T00:00:00Z', '2026-10-23T00:00:00Z')").run();
    const o = await runPython("[]");
    expect(o.status).toBe("ok");
    expect(await coverage()).toBeNull();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${PY_RETRYING_SQL}`).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n")).toContain("idx_python_runtime_records_state_next");
  });
});
