import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// TCS-38: migrations/0024_osv_more_ecosystems.sql appends Maven, NuGet, Hex,
// Pub, Alpine and Debian to sources.config_json.ecosystems of row osv. It
// never removes or reorders a list an operator edited, and a second apply
// changes nothing. Each test sets the row it starts from.

const NEW = ["Maven", "NuGet", "Hex", "Pub", "Alpine", "Debian"];
const OLD = ["npm", "PyPI", "Go", "Packagist", "crates.io", "RubyGems"];

const migration = () => {
  const m = env.TEST_MIGRATIONS.find((x) => x.name === "0024_osv_more_ecosystems.sql");
  expect(m, "migrations/0024_osv_more_ecosystems.sql").toBeDefined();
  return m!;
};

async function apply(): Promise<number> {
  let changes = 0;
  for (const q of migration().queries) changes += (await env.DB.prepare(q).run()).meta.changes;
  return changes;
}

async function config(): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT config_json FROM sources WHERE id = 'osv'").first<{ config_json: string }>();
  return JSON.parse(row!.config_json) as Record<string, unknown>;
}

const setConfig = (json: string) => env.DB.prepare("UPDATE sources SET config_json = ? WHERE id = 'osv'").bind(json).run();

describe("0024_osv_more_ecosystems.sql", () => {
  it("is applied by the setup: row osv lists the 12 ecosystems, old ones first", async () => {
    const names = (await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results.map((r) => r.name);
    expect(names).toContain("0024_osv_more_ecosystems.sql");
    expect((await config()).ecosystems).toEqual([...OLD, ...NEW]);
  });

  it("a second apply changes 0 rows and keeps the order", async () => {
    await setConfig(JSON.stringify({ ecosystems: [...OLD, ...NEW] }));
    expect(await apply()).toBe(0);
    expect((await config()).ecosystems).toEqual([...OLD, ...NEW]);
  });

  it("an edited list keeps its order and its other keys and gets only the missing names", async () => {
    await setConfig(JSON.stringify({ ecosystems: ["npm", "Maven"], page_size: 10 }));
    await apply();
    expect(await config()).toEqual({ ecosystems: ["npm", "Maven", "NuGet", "Hex", "Pub", "Alpine", "Debian"], page_size: 10 });
    expect(await apply()).toBe(0);
  });

  it("a list without npm stays without npm", async () => {
    await setConfig(JSON.stringify({ ecosystems: ["Go"] }));
    await apply();
    expect((await config()).ecosystems).toEqual(["Go", ...NEW]);
  });

  it("an empty config gets the code fallback list first, then the six", async () => {
    await setConfig("{}");
    await apply();
    expect((await config()).ecosystems).toEqual([...OLD, ...NEW]);
  });

  it("has no DROP, DELETE or schema change", () => {
    for (const q of migration().queries) expect(q).not.toMatch(/\b(DROP|DELETE|ALTER|CREATE)\b/i);
  });
});
