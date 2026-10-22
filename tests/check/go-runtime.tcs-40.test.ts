import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { GO_RUNTIME_CANDIDATE_SQL } from "../../src/check/candidates";
import { normalizeOsv, type OsvVuln } from "../../src/ingest/osv";
import { upsertAdvisory } from "../../src/ingest/upsert";
import type { Advisory, AffectedRange } from "../../src/schema/advisory";
import { validateAdvisory } from "../../src/schema/advisory";
import nodeFixture from "../fixtures/advisory/valid.json";
import osvPage from "../fixtures/osv/page1.json";
import { get, idFor } from "../routes/seed.tcs-3";

// TCS-40: an OSV `Go` advisory on `stdlib`, `toolchain` or `cmd/*` also
// answers the runtime query `go=<version>`. One stored row, two match paths.
// Seed ids use the Crockford prefix "G40"; every test sends its own client IP.

interface Affected {
  dependency: { ecosystem: string; name: string; version: string };
  advisory_id: string;
  fixed_in: string | null;
}
interface CheckAnswer {
  checked: number;
  affected: Affected[];
  skipped: Array<{ dependency?: { ecosystem: string; name: string }; reason: string; advisory_ids?: string[] }>;
}

const ID = {
  stdlib: idFor("G40", 0),
  toolchain: idFor("G40", 1),
  cmdGo: idFor("G40", 2),
  module: idFor("G40", 3),
  cmdNoSlash: idFor("G40", 4),
  cmdZero: idFor("G40", 5),
};
const OURS: string[] = Object.values(ID);
const FIXED_1224: AffectedRange[] = [{ introduced: "0", fixed: "1.22.4" }];
let osvStdlibId = "";

function docFrom(id: string, component: string, affected: AffectedRange[], cursor: number): [Advisory, number] {
  const doc = structuredClone(nodeFixture) as Advisory;
  doc.id = id;
  doc.ecosystem = "Go";
  doc.component = component;
  doc.affected = affected;
  doc.fixed_versions = affected.flatMap((r) => (r.fixed ? [r.fixed] : []));
  doc.cve_ids = [];
  doc.action = `Upgrade ${component} to 1.22.4 or later.`;
  doc.sources = [{ source: "osv", source_id: id, url: `https://example.com/fixture/${id}` }];
  const v = validateAdvisory(doc);
  if (!v.ok) throw new Error(`seed doc invalid: ${v.errors.join("; ")}`);
  return [doc, cursor];
}

async function insert(rows: [Advisory, number][]): Promise<void> {
  const stmt = env.DB.prepare(
    `INSERT INTO advisories (id, cve_primary, ecosystem, component, severity_label, exploited, published_at, modified_at, doc_json, cursor)
     VALUES (?, NULL, ?, ?, ?, 0, ?, ?, ?, ?)`,
  );
  await env.DB.batch(
    rows.map(([d, cursor]) =>
      stmt.bind(d.id, d.ecosystem, d.component, d.severity.label, d.published_at, d.modified_at, JSON.stringify(d), cursor),
    ),
  );
}

function post(body: unknown, ip: string): Promise<Response> {
  return exports.default.fetch("https://tocsin.test/v1/check", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function check(path: string, ip: string): Promise<CheckAnswer> {
  const res = await get(path, ip);
  expect(res.status).toBe(200);
  return (await res.json()) as CheckAnswer;
}

const ids = (a: CheckAnswer) => a.affected.map((x) => x.advisory_id);

async function rowCount(): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisories").first<{ n: number }>();
  return r!.n;
}

beforeAll(async () => {
  await insert([
    docFrom(ID.stdlib, "stdlib", FIXED_1224, 940_001),
    docFrom(ID.toolchain, "toolchain", FIXED_1224, 940_002),
    docFrom(ID.cmdGo, "cmd/go", FIXED_1224, 940_003),
    docFrom(ID.module, "github.com/x/y", FIXED_1224, 940_004),
    docFrom(ID.cmdNoSlash, "cmd", FIXED_1224, 940_005),
    docFrom(ID.cmdZero, "cmd0", FIXED_1224, 940_006),
  ]);

  // The real OSV record GO-2024-2963 (stdlib, fixed 1.21.12 and 1.22.5), through the real ingest path.
  const vuln = structuredClone((osvPage as unknown as OsvVuln[]).find((v) => v.id === "GO-2024-2963")!);
  vuln.aliases = [];
  const norm = normalizeOsv(vuln, ["Go"]);
  if (!norm.ok) throw new Error(norm.reason);
  await upsertAdvisory(env.DB, norm.doc, { source: "osv", source_id: "GO-2024-2963-tcs40" });
  const row = await env.DB.prepare("SELECT advisory_id FROM advisory_sources WHERE source = 'osv' AND source_id = ?")
    .bind("GO-2024-2963-tcs40")
    .first<{ advisory_id: string }>();
  osvStdlibId = row!.advisory_id;
});

describe("GET /v1/check?go= reads Go toolchain advisories as a runtime", () => {
  it("returns the Go/stdlib advisory for go=1.22.3 with fixed_in from the OSV fixed event", async () => {
    const a = await check("/v1/check?go=1.22.3", "198.51.100.40");
    const hit = a.affected.find((x) => x.advisory_id === ID.stdlib);
    expect(hit).toEqual(
      expect.objectContaining({ dependency: { ecosystem: "go", name: "go", version: "1.22.3" }, fixed_in: "1.22.4" }),
    );
    expect(a.checked).toBe(1);
  });

  it("does not return it for go=1.22.4 (the fixed version)", async () => {
    const a = await check("/v1/check?go=1.22.4", "198.51.100.41");
    expect(ids(a)).not.toContain(ID.stdlib);
    expect(ids(a).filter((id) => OURS.includes(id))).toEqual([]);
  });

  it("returns toolchain and cmd/* advisories, never a module or a cmd name without the slash", async () => {
    const a = await check("/v1/check?go=go1.22.3", "198.51.100.42");
    const ours = ids(a).filter((id) => OURS.includes(id)).sort();
    expect(ours).toEqual([ID.stdlib, ID.toolchain, ID.cmdGo].sort());
    expect(ids(a)).not.toContain(ID.module);
    expect(ids(a)).not.toContain(ID.cmdNoSlash);
    expect(ids(a)).not.toContain(ID.cmdZero);
  });

  it("uses the OSV range events of an ingested stdlib record (GO-2024-2963)", async () => {
    const at = async (v: string, ip: string) =>
      (await check(`/v1/check?go=${v}`, ip)).affected.find((x) => x.advisory_id === osvStdlibId)?.fixed_in;
    expect(await at("1.22.3", "198.51.100.43")).toBe("1.22.5");
    expect(await at("1.21.11", "198.51.100.44")).toBe("1.21.12");
    expect(await at("1.22.5", "198.51.100.45")).toBeUndefined();
    expect(await at("1.21.12", "198.51.100.46")).toBeUndefined();
  });

  it("does not add an advisory row: the runtime view is in the matcher", async () => {
    const before = await rowCount();
    await check("/v1/check?go=1.22.3", "198.51.100.47");
    expect(await rowCount()).toBe(before);
    const { results } = await env.DB.prepare(
      "SELECT ecosystem, component FROM advisories WHERE id IN (SELECT value FROM json_each(?)) ORDER BY component",
    )
      .bind(JSON.stringify([ID.stdlib, osvStdlibId]))
      .all<{ ecosystem: string; component: string }>();
    expect(results).toEqual([
      { ecosystem: "Go", component: "stdlib" },
      { ecosystem: "Go", component: "stdlib" },
    ]);
    const go = await env.DB.prepare("SELECT COUNT(*) AS n FROM advisories WHERE ecosystem = 'go'").first<{ n: number }>();
    expect(go!.n).toBe(0);
  });
});

describe("POST /v1/check with runtimes.go (the CLI path)", () => {
  it("returns the stdlib advisory once for the runtime, and keeps it a Go module candidate", async () => {
    const res = await post(
      { runtimes: { go: "1.22.3" }, dependencies: [{ ecosystem: "Go", name: "stdlib", version: "v1.22.3" }] },
      "198.51.100.48",
    );
    expect(res.status).toBe(200);
    const a = (await res.json()) as CheckAnswer;
    const runtimeHits = a.affected.filter((x) => x.advisory_id === ID.stdlib && x.dependency.ecosystem === "go");
    expect(runtimeHits).toHaveLength(1);
    expect(runtimeHits[0].fixed_in).toBe("1.22.4");
    // The module path still sees the row under ecosystem Go (affected or skipped, never dropped).
    const asModule =
      a.affected.some((x) => x.advisory_id === ID.stdlib && x.dependency.ecosystem === "Go") ||
      a.skipped.some((s) => s.dependency?.ecosystem === "Go" && (s.advisory_ids ?? []).includes(ID.stdlib));
    expect(asModule).toBe(true);
  });

  it("a Go module dependency never matches through the runtime view", async () => {
    const res = await post({ dependencies: [{ ecosystem: "Go", name: "github.com/x/y", version: "v1.0.0" }] }, "198.51.100.49");
    const a = (await res.json()) as CheckAnswer;
    expect(ids(a).filter((id) => OURS.includes(id))).toEqual([]);
  });
});

describe("query plan", () => {
  it("the Go runtime candidate query uses idx_advisories_component_ecosystem, never a bare scan", async () => {
    const stmt = env.DB.prepare(
      "INSERT INTO advisories (id, ecosystem, component, published_at, modified_at, doc_json, cursor) VALUES (?, ?, ?, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '{}', ?)",
    );
    const ecos = ["Go", "npm", "PyPI", "node"];
    const stmts = Array.from({ length: 2000 }, (_, i) =>
      stmt.bind(idFor("G40P", i), ecos[i % 4], i % 50 === 0 ? `cmd/tool${i}` : `pkg-fixture-${i % 400}`, 950_000 + i),
    );
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    await env.DB.prepare("ANALYZE").run();
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${GO_RUNTIME_CANDIDATE_SQL}`).all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toContain("idx_advisories_component_ecosystem");
    expect(plan).not.toMatch(/SCAN advisories(?! USING)/);
  });
});
