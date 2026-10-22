import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { CANDIDATE_SQL, FEED_CURSOR_SQL, PYPI_CANDIDATE_SQL, candidateKeys } from "../../src/check/candidates";
import { idFor, seed, type SeedRow } from "./seed.tcs-3";

// EXPLAIN QUERY PLAN on the exact SQL the /v1/check route runs, over 2,000
// seeded advisories, with a full 200-key chunk as the bound parameter.

const ECOSYSTEMS = ["node", "php", "npm", "PyPI", "Go", "crates.io"];

async function plan(sql: string, params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

beforeAll(async () => {
  const rows: SeedRow[] = Array.from({ length: 2000 }, (_, i) => ({
    id: idFor("C9P", i),
    cursor: 1 + i,
    ecosystem: ECOSYSTEMS[i % ECOSYSTEMS.length],
    component: `pkg-fixture-${i % 400}`,
  }));
  await seed(rows);
});

describe("check query plans on 2,000 advisories", () => {
  it("the candidate query uses advisories(component, ecosystem), never a bare scan", async () => {
    const deps = Array.from({ length: 200 }, (_, i) => ({ ecosystem: "npm", name: `pkg-fixture-${i}`, version: "1.0.0" }));
    const keys = candidateKeys(deps).exact;
    expect(keys).toHaveLength(200);
    const p = await plan(CANDIDATE_SQL, [JSON.stringify(keys)]);
    expect(p).toContain("USING INDEX idx_advisories_component_ecosystem");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("the candidate query returns exactly the rows for the keys", async () => {
    const keys = candidateKeys([
      { ecosystem: "npm", name: "pkg-fixture-2", version: "1.0.0" },
      { ecosystem: "node", name: "pkg-fixture-0", version: "1.0.0" },
    ]).exact;
    const { results } = await env.DB.prepare(CANDIDATE_SQL).bind(JSON.stringify(keys)).all<{ doc_json: string }>();
    const docs = results.map((r) => JSON.parse(r.doc_json) as { ecosystem: string; component: string });
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      expect([`npm/pkg-fixture-2`, `node/pkg-fixture-0`]).toContain(`${d.ecosystem}/${d.component}`);
    }
    // Row i has ecosystem i % 6 and component i % 400, a pattern that repeats every 1,200 rows:
    // npm/pkg-fixture-2 is rows 2 and 1202, node/pkg-fixture-0 is rows 0 and 1200.
    expect(docs.length).toBe(4);
  });

  it("the PyPI candidate query uses the normalized-name index, never a bare scan", async () => {
    const deps = Array.from({ length: 200 }, (_, i) => ({ ecosystem: "PyPI", name: `Pkg_Fixture.${i}`, version: "1.0" }));
    const keys = candidateKeys(deps).pypi;
    expect(keys).toHaveLength(200);
    const p = await plan(PYPI_CANDIDATE_SQL, [JSON.stringify(keys)]);
    expect(p).toContain("USING INDEX idx_advisories_pypi_name");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("the PyPI candidate query finds rows stored with OSV casing and punctuation", async () => {
    const ids = [idFor("C9PY", 0), idFor("C9PY", 1), idFor("C9PY", 2)];
    await seed([
      { id: ids[0], cursor: 5001, ecosystem: "PyPI", component: "Plan_Fixture..Name" },
      { id: ids[1], cursor: 5002, ecosystem: "python", component: "PLAN-fixture-name" },
      { id: ids[2], cursor: 5003, ecosystem: "npm", component: "plan-fixture-name" },
    ]);
    const { pypi } = candidateKeys([
      { ecosystem: "PyPI", name: "plan.fixture__name", version: "1" },
      { ecosystem: "python", name: "Plan-Fixture-Name", version: "1" },
    ]);
    const { results } = await env.DB.prepare(PYPI_CANDIDATE_SQL).bind(JSON.stringify(pypi)).all<{ doc_json: string }>();
    const got = results.map((r) => (JSON.parse(r.doc_json) as { id: string }).id).sort();
    expect(got).toEqual([ids[0], ids[1]].sort());
  });

  it("candidateKeys queries the normalized PyPI name, splits by query and dedupes", () => {
    const keys = candidateKeys([
      { ecosystem: "PyPI", name: "Zope.Interface", version: "1" },
      { ecosystem: "PyPI", name: "zope_interface", version: "2" },
      { ecosystem: "npm", name: "Zope.Interface", version: "1" },
    ]);
    expect(keys).toEqual({
      exact: [["npm", "Zope.Interface"]],
      pypi: [["PyPI", "zope-interface"]],
    });
  });

  it("the feed cursor read uses the cursor index", async () => {
    const p = await plan(FEED_CURSOR_SQL, []);
    expect(p).toMatch(/idx_advisories_cursor/);
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });
});

describe("settings rows for the check limits", () => {
  it("seeds check.anon_rate_per_minute = 20 and check.max_body_bytes = 2097152", async () => {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('check.anon_rate_per_minute', 'check.max_body_bytes') ORDER BY key",
    ).all<{ key: string; value: string }>();
    expect(results).toEqual([
      { key: "check.anon_rate_per_minute", value: "20" },
      { key: "check.max_body_bytes", value: "2097152" },
    ]);
  });
});
