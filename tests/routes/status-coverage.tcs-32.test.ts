import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { get } from "./seed.tcs-3";

// Coverage on /v1/status (JSON) and /status (HTML), through the production routes.
interface StatusJson {
  sources: { id: string; coverage_since: string | null }[];
  coverage: { ecosystem: string; since: string | null; complete: boolean; imported: number | null; skipped: number | null }[];
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM backfill").run();
  await env.DB.prepare("UPDATE sources SET coverage_since = NULL").run();
  await env.DB.prepare("UPDATE sources SET config_json = '{}' WHERE id = 'osv'").run();
});

describe("/v1/status coverage", () => {
  it("lists sources[].coverage_since and one coverage row per OSV ecosystem and runtime", async () => {
    await env.DB.prepare("INSERT INTO backfill (ecosystem, started_at, done_at, imported, unchanged, coverage_since) VALUES ('npm', '2026-10-23T00:00:00Z', '2026-10-23T02:00:00Z', 200000, 12, '2016-01-05T00:00:00Z')").run();
    await env.DB.prepare("INSERT INTO backfill (ecosystem, started_at, imported, coverage_since) VALUES ('PyPI', '2026-10-23T00:00:00Z', 5000, '2026-10-15T00:00:00Z')").run();
    await env.DB.prepare("UPDATE sources SET coverage_since = '2018-03-01T00:00:00Z' WHERE id = 'node-runtime'").run();

    const res = await get("/v1/status", "203.0.113.31");
    expect(res.status).toBe(200);
    const s = (await res.json()) as StatusJson;
    expect(s.sources.find((x) => x.id === "node-runtime")?.coverage_since).toBe("2018-03-01T00:00:00Z");
    expect(s.sources.find((x) => x.id === "php-runtime")?.coverage_since).toBeNull();
    const by = new Map(s.coverage.map((c) => [c.ecosystem, c]));
    expect(by.get("npm")).toEqual({ ecosystem: "npm", since: "2016-01-05T00:00:00Z", complete: true, imported: 200012, skipped: 0 });
    expect(by.get("PyPI")).toEqual({ ecosystem: "PyPI", since: "2026-10-15T00:00:00Z", complete: false, imported: 5000, skipped: 0 });
    expect(by.get("Go")).toEqual({ ecosystem: "Go", since: null, complete: false, imported: 0, skipped: 0 });
    expect(by.get("node")).toEqual({ ecosystem: "node", since: "2018-03-01T00:00:00Z", complete: true, imported: null, skipped: null });
    expect(by.get("php")).toEqual({ ecosystem: "php", since: null, complete: false, imported: null, skipped: null });
    expect([...by.keys()]).toEqual(["crates.io", "Go", "npm", "Packagist", "PyPI", "RubyGems", "bun", "deno", "go", "node", "php", "python"]);
  });
});

describe("/status coverage table", () => {
  it("shows a Coverage since column and the per-ecosystem coverage table, partial rows named", async () => {
    await env.DB.prepare("INSERT INTO backfill (ecosystem, started_at, done_at, imported, coverage_since) VALUES ('npm', '2026-10-23T00:00:00Z', '2026-10-23T02:00:00Z', 7, '2016-01-05T00:00:00Z')").run();
    const res = await get("/status", "203.0.113.32");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<th scope="col">coverage since</th>');
    expect(html).toContain("<h2>Coverage</h2>");
    expect(html).toMatch(/<tr><td>npm<\/td><td class="nowrap">2016-01-05T00:00:00Z<\/td><td>complete<\/td><td>7<\/td><\/tr>/);
    expect(html).toMatch(/<tr><td>PyPI<\/td><td class="nowrap">-<\/td><td>partial<\/td><td>0<\/td><\/tr>/);
    expect(html).toMatch(/<tr><td>node<\/td><td class="nowrap">-<\/td><td>partial<\/td><td>-<\/td><\/tr>/);
  });
});
