import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nvd } from "../../src/ingest/nvd";
import type { AdvisoryInput } from "../../src/ingest/types";
import { upsertAdvisory } from "../../src/ingest/upsert";
import type { Advisory } from "../../src/schema/advisory";
import { createNvdFake, FAKE_NVD_BASE } from "./enrich-fake.tcs-7";

let refused = 0;
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    refused += 1;
    throw new Error(`real network call refused: ${String(input)}`);
  });
});
afterAll(() => {
  expect(refused).toBe(0);
  vi.restoreAllMocks();
});

const CVE = "CVE-2026-830001";
const SOURCE_ID = "GHSA-fixture-tcs7-upsert-1";

function osvDoc(severity: AdvisoryInput["severity"]): AdvisoryInput {
  return {
    cve_ids: [CVE],
    ecosystem: "npm",
    component: "fixture-upsert",
    affected: [{ introduced: "0", fixed: "1.0.1" }],
    fixed_versions: ["1.0.1"],
    severity,
    exploited: false,
    published_at: "2026-10-20T00:00:00Z",
    modified_at: "2026-10-20T00:00:00Z",
    summary: "Fixture advisory.",
    action: "Upgrade fixture-upsert to 1.0.1 or later.",
    references: [`https://osv.dev/vulnerability/${SOURCE_ID}`],
    sources: [{ source: "osv", source_id: SOURCE_ID, url: `https://osv.dev/vulnerability/${SOURCE_ID}` }],
  };
}

async function row() {
  return env.DB.prepare(
    "SELECT a.severity_score, a.severity_label, a.doc_json, a.cursor FROM advisory_sources s JOIN advisories a ON a.id = s.advisory_id WHERE s.source = 'osv' AND s.source_id = ?",
  )
    .bind(SOURCE_ID)
    .first<{ severity_score: number | null; severity_label: string; doc_json: string; cursor: number }>();
}

describe("upsert keeps an NVD score across a scoreless OSV re-ingest", () => {
  it("OSV (no score) -> NVD 9.2 -> OSV again with no score keeps 9.2; OSV with a score 5.0 replaces it", async () => {
    const key = { source: "osv", source_id: SOURCE_ID };
    await upsertAdvisory(env.DB, osvDoc({ label: "unknown" }), key);
    const fake = createNvdFake();
    await nvd.run({
      env,
      source: { id: "nvd", kind: "nvd", config: { api_base: FAKE_NVD_BASE } },
      now: () => new Date("2026-10-22T14:00:00Z"),
      fetch: fake.fetch,
    });
    expect(fake.calls.map((c) => c.cve)).toEqual([CVE]);
    const scored = await row();
    expect(scored?.severity_score).toBe(9.2);

    expect(await upsertAdvisory(env.DB, osvDoc({ label: "unknown" }), key)).toBe("unchanged");
    const kept = await row();
    expect(kept?.severity_score).toBe(9.2);
    expect(kept?.severity_label).toBe("critical");
    expect((JSON.parse(kept!.doc_json) as Advisory).severity).toEqual({ score: 9.2, label: "critical" });
    expect(kept?.cursor).toBe(scored?.cursor);

    expect(await upsertAdvisory(env.DB, osvDoc({ score: 5.0, label: "medium" }), key)).toBe("updated");
    const replaced = await row();
    expect(replaced?.severity_score).toBe(5);
    expect(replaced?.severity_label).toBe("medium");
  });
});
