import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { CANDIDATE_SQL, candidateKeys } from "../../src/check/candidates";
import { idFor, seed, type SeedRow } from "./seed.tcs-3";

// TCS-38: EXPLAIN QUERY PLAN of the /v1/check candidate query for the new
// ecosystems, over 20,000 seeded advisories in all 12 OSV ecosystems. A
// Debian:12 dependency is queried on the base name Debian, so the same
// (component, ecosystem) index serves it.

const ECOSYSTEMS = ["npm", "PyPI", "Go", "Packagist", "crates.io", "RubyGems", "Maven", "NuGet", "Hex", "Pub", "Alpine", "Debian"];

async function plan(sql: string, params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

beforeAll(async () => {
  const rows: SeedRow[] = Array.from({ length: 20_000 }, (_, i) => ({
    id: idFor("C38P", i),
    cursor: 1 + i,
    ecosystem: ECOSYSTEMS[i % ECOSYSTEMS.length],
    component: i % 997 === 0 ? "openssl" : `pkg-fixture-${i % 1500}`,
  }));
  await seed(rows);
}, 120_000);

describe("check query plan on 20,000 advisories in 12 ecosystems", () => {
  it("Maven and Debian:12 keys use idx_advisories_component_ecosystem, never a bare scan", async () => {
    const keys = candidateKeys([
      { ecosystem: "Maven", name: "org.apache.logging.log4j:log4j-core", version: "2.14.1" },
      { ecosystem: "Debian:12", name: "openssl", version: "3.0.11-1~deb12u1" },
      { ecosystem: "Alpine:v3.18", name: "openssl", version: "3.1.4-r0" },
    ]).exact;
    expect(keys).toEqual([
      ["Maven", "org.apache.logging.log4j:log4j-core"],
      ["Debian", "openssl"],
      ["Alpine", "openssl"],
    ]);
    const p = await plan(CANDIDATE_SQL, [JSON.stringify(keys)]);
    expect(p).toContain("USING INDEX idx_advisories_component_ecosystem");
    expect(p).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("the Debian key returns only Debian rows of that component", async () => {
    const keys = candidateKeys([{ ecosystem: "Debian:12", name: "openssl", version: "1" }]).exact;
    const { results } = await env.DB.prepare(CANDIDATE_SQL).bind(JSON.stringify(keys)).all<{ doc_json: string }>();
    const docs = results.map((r) => JSON.parse(r.doc_json) as { ecosystem: string; component: string });
    // Row i is openssl when i = 997k (k = 0..20) and Debian when i % 12 == 11.
    // 997 ≡ 1 (mod 12), so k ≡ 11: only row 10,967.
    expect(docs.length).toBe(1);
    for (const d of docs) expect([d.ecosystem, d.component]).toEqual(["Debian", "openssl"]);
  });
});
