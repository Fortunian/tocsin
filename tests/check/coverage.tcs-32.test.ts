import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { coverageFor, coverageOwner } from "../../src/check/coverage";
import { nodeEol } from "../../src/ingest/node-eol";
import { idFor, seed } from "../routes/seed.tcs-3";
import distIndex from "../fixtures/node-eol/index.json?raw";
import schedule from "../fixtures/node-eol/schedule.json?raw";

// Honest coverage in /v1/check (TCS-32), through the production route.
interface Coverage {
  ecosystem: string;
  since: string | null;
  complete: boolean;
}
interface Answer {
  checked: number;
  affected: { dependency: { ecosystem: string; name: string; version: string }; advisory_id: string; fixed_in: string | null; action: string; severity: { label: string } }[];
  skipped: { dependency?: { ecosystem: string; name: string }; reason: string; since?: string | null; advisory_ids?: string[] }[];
  coverage: Coverage[];
}

let ip = 0;
const nextIp = () => `198.51.100.${(ip++ % 250) + 1}`;

async function postCheck(dependencies: unknown[], runtimes?: Record<string, string>): Promise<Answer> {
  const res = await exports.default.fetch("https://tocsin.test/v1/check", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
    body: JSON.stringify(runtimes ? { dependencies, runtimes } : { dependencies }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Answer;
}

async function getCheck(query: string): Promise<Answer> {
  const res = await exports.default.fetch(`https://tocsin.test/v1/check?${query}`, { headers: { "CF-Connecting-IP": nextIp() } });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Answer;
}

const done = (eco: string, since = "2016-01-01T00:00:00Z") =>
  env.DB.prepare("INSERT INTO backfill (ecosystem, started_at, done_at, imported, coverage_since) VALUES (?, ?, ?, 10, ?) ON CONFLICT(ecosystem) DO UPDATE SET done_at = excluded.done_at, coverage_since = excluded.coverage_since")
    .bind(eco, "2026-10-23T00:00:00Z", "2026-10-23T01:00:00Z", since)
    .run();
const partial = (eco: string, since = "2026-10-15T00:00:00Z") =>
  env.DB.prepare("INSERT INTO backfill (ecosystem, started_at, imported, coverage_since) VALUES (?, ?, 3, ?) ON CONFLICT(ecosystem) DO UPDATE SET done_at = NULL, coverage_since = excluded.coverage_since")
    .bind(eco, "2026-10-23T00:00:00Z", since)
    .run();

const PY_DEP = { ecosystem: "PyPI", name: "tcs32-clean-fixture", version: "1.0.0" };
// 22.1.0 is inside the seed fixture range [22.0.0, 22.23.4) (tests/fixtures/advisory/valid.json).
const PY_VULN = { ecosystem: "PyPI", name: "tcs32-vuln-fixture", version: "22.1.0" };

beforeAll(async () => {
  const [vuln] = await seed([{ id: idFor("CV32", 1), cursor: 3201, ecosystem: "PyPI", component: "tcs32-vuln-fixture" }]);
  expect(vuln.affected.length).toBeGreaterThan(0);
  await seed([{ id: idFor("CV32", 2), cursor: 3202, ecosystem: "Go", component: "stdlib" }]);
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM backfill").run();
  await env.DB.prepare("UPDATE sources SET coverage_since = NULL").run();
});

describe("coverageFor (pure)", () => {
  it("maps each checked ecosystem to its owner row; no row is complete: false", () => {
    expect(coverageOwner("go")).toEqual({ table: "backfill", key: "Go" });
    expect(coverageOwner("node")).toEqual({ table: "sources", key: "node-runtime" });
    expect(coverageOwner("PyPI")).toEqual({ table: "backfill", key: "PyPI" });
    const got = coverageFor(["php", "PyPI", "npm", "PyPI"], {
      backfill: [{ ecosystem: "npm", coverage_since: "2016-01-05T00:00:00Z", done_at: "2026-10-23T01:00:00Z" }, { ecosystem: "PyPI", coverage_since: "2026-10-15T00:00:00Z", done_at: null }],
      sources: [{ id: "php-runtime", coverage_since: null }],
    });
    expect(got).toEqual([
      { ecosystem: "npm", since: "2016-01-05T00:00:00Z", complete: true },
      { ecosystem: "php", since: null, complete: false },
      { ecosystem: "PyPI", since: "2026-10-15T00:00:00Z", complete: false },
    ]);
  });
});

describe("POST /v1/check coverage", () => {
  it("no done PyPI row: a PyPI dependency with no advisory is skipped as partial_coverage, never clean", async () => {
    await partial("PyPI");
    const a = await postCheck([PY_DEP]);
    expect(a.affected).toEqual([]);
    expect(a.skipped).toContainEqual({ dependency: PY_DEP, reason: "partial_coverage", since: "2026-10-15T00:00:00Z" });
    expect(a.coverage).toEqual([{ ecosystem: "PyPI", since: "2026-10-15T00:00:00Z", complete: false }]);
  });

  it("no backfill row at all: partial_coverage with since null", async () => {
    const a = await postCheck([PY_DEP]);
    expect(a.skipped).toContainEqual({ dependency: PY_DEP, reason: "partial_coverage", since: null });
    expect(a.coverage).toEqual([{ ecosystem: "PyPI", since: null, complete: false }]);
  });

  it("a done PyPI row: the same dependency is clean and complete: true", async () => {
    await done("PyPI");
    const a = await postCheck([PY_DEP]);
    expect(a.affected).toEqual([]);
    expect(a.skipped).toEqual([]);
    expect(a.coverage).toEqual([{ ecosystem: "PyPI", since: "2016-01-01T00:00:00Z", complete: true }]);
  });

  it("a dependency with an affected item in a partial ecosystem stays in affected and is not also skipped", async () => {
    await partial("PyPI");
    const a = await postCheck([PY_VULN, PY_DEP]);
    expect(a.affected.map((x) => x.dependency.name)).toEqual(["tcs32-vuln-fixture"]);
    expect(a.skipped.filter((s) => s.dependency?.name === "tcs32-vuln-fixture")).toEqual([]);
    expect(a.skipped.filter((s) => s.reason === "partial_coverage").map((s) => s.dependency?.name)).toEqual(["tcs32-clean-fixture"]);
  });

  it("an invalid_version item does not also get partial_coverage", async () => {
    const bad = { ecosystem: "PyPI", name: "tcs32-vuln-fixture", version: "not a version!" };
    const a = await postCheck([bad]);
    expect(a.skipped.map((s) => s.reason)).toEqual(["invalid_version"]);
  });

  it("coverage lists only the checked ecosystems, sorted; an unsupported ecosystem is not listed", async () => {
    await done("npm");
    const a = await postCheck([PY_DEP, { ecosystem: "npm", name: "tcs32-npm-clean", version: "1.0.0" }, { ecosystem: "Hackage", name: "x", version: "1" }]);
    expect(a.coverage.map((c) => c.ecosystem)).toEqual(["npm", "PyPI"]);
    expect(a.skipped.map((s) => s.reason).sort()).toEqual(["partial_coverage", "unsupported_ecosystem"]);
  });
});

describe("GET /v1/check runtimes", () => {
  it("the go runtime follows the Go backfill row", async () => {
    const before = await getCheck("go=1.99.0");
    expect(before.coverage).toEqual([{ ecosystem: "go", since: null, complete: false }]);
    expect(before.skipped.map((s) => s.reason)).toContain("partial_coverage");
    await done("Go");
    const after = await getCheck("go=1.99.0");
    expect(after.coverage).toEqual([{ ecosystem: "go", since: "2016-01-01T00:00:00Z", complete: true }]);
    expect(after.skipped).toEqual([]);
  });

  it("node follows sources.node-runtime.coverage_since", async () => {
    expect((await getCheck("node=99.0.0")).coverage).toEqual([{ ecosystem: "node", since: null, complete: false }]);
    await env.DB.prepare("UPDATE sources SET coverage_since = '2018-03-01T00:00:00.000Z' WHERE id = 'node-runtime'").run();
    const a = await getCheck("node=99.0.0");
    expect(a.coverage).toEqual([{ ecosystem: "node", since: "2018-03-01T00:00:00.000Z", complete: true }]);
    expect(a.skipped).toEqual([]);
  });

  it("with the node-eol advisories stored, node=18.19.0 gets the EOL advisory with fixed_in null; node=22.12.0 does not", async () => {
    const routes: Record<string, string> = {
      "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json": schedule,
      "https://nodejs.org/dist/index.json": distIndex,
    };
    const fetchFake = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!Object.hasOwn(routes, url)) throw new Error(`unrouted ${url}`);
      return new Response(routes[url], { status: 200 });
    }) as typeof fetch;
    const r = await nodeEol.run({ env, source: { id: "node-eol", kind: "node-eol", config: {} }, now: () => new Date("2026-10-23T01:00:00Z"), fetch: fetchFake });
    expect(r.errors).toEqual([]);

    const old = await getCheck("node=18.19.0");
    const eol = old.affected.filter((x) => x.action.includes("end of life") || /Upgrade node to 22\.x/.test(x.action));
    expect(eol).toHaveLength(1);
    expect(eol[0].fixed_in).toBeNull();
    expect(eol[0].severity.label).toBe("high");
    expect(eol[0].action).toBe("Upgrade node to 22.x or later.");

    const current = await getCheck("node=22.12.0");
    expect(current.affected.filter((x) => /Upgrade node to 22\.x or later/.test(x.action))).toEqual([]);
  });
});
