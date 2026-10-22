import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { normalizeOsv, type OsvVuln } from "../../src/ingest/osv";
import { upsertAdvisory } from "../../src/ingest/upsert";
import multi from "../fixtures/osv/multi-package.tcs-46.json";
import { get } from "../routes/seed.tcs-3";

// TCS-46 on the Go runtime path (TCS-40): an OSV record that lists a module
// first and stdlib second still answers go=<version> through its stdlib row.
// GO-2022-0969 in multi-package.tcs-46.json is source: assumed (api.osv.dev
// was not reachable from the build box); this test reorders its two entries.

interface CheckAnswer {
  affected: { advisory_id: string; fixed_in: string | null }[];
}

async function check(path: string, ip: string): Promise<CheckAnswer> {
  const res = await get(path, ip);
  expect(res.status).toBe(200);
  return (await res.json()) as CheckAnswer;
}

describe("GET /v1/check?go= with an OSV record that lists a module first, stdlib second", () => {
  it("module first, stdlib second returns the runtime hit", async () => {
    const v = structuredClone((multi as unknown as OsvVuln[]).find((x) => x.id === "GO-2022-0969")!);
    v.id = "GO-2022-0969-tcs46";
    v.aliases = [];
    v.affected = [v.affected![1], v.affected![0]];
    expect(v.affected.map((a) => a.package?.name)).toEqual(["golang.org/x/net", "stdlib"]);

    const norm = normalizeOsv(v, ["Go"]);
    if (!norm.ok) throw new Error(norm.reason);
    for (const d of norm.docs) await upsertAdvisory(env.DB, d.doc, { source: "osv", source_id: d.source_id });

    const row = await env.DB.prepare("SELECT advisory_id FROM advisory_sources WHERE source = 'osv' AND source_id = ?")
      .bind("GO-2022-0969-tcs46#Go/stdlib")
      .first<{ advisory_id: string }>();
    expect(row).not.toBeNull();
    const stdlibId = row!.advisory_id;

    const hit = (await check("/v1/check?go=1.18.5", "198.51.100.146")).affected.find((x) => x.advisory_id === stdlibId);
    expect(hit?.fixed_in).toBe("1.18.6");
    const fixed = await check("/v1/check?go=1.19.1", "198.51.100.147");
    expect(fixed.affected.map((x) => x.advisory_id)).not.toContain(stdlibId);
  });
});
