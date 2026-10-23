import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildZip, jsonEntry, osvRecord } from "../backfill/zip-fixture.tcs-32";
import { type LocalWorker, startLocalWorker } from "./local-worker.tcs-14";

// The opt-in coverage checks of scripts/launch-check.sh (TCS-32), against the
// real worker in Miniflare. The worker is seeded the production way: the
// backfill script (scripts/backfill/run.mjs, as the workflow runs it) reads
// an all.zip from a local OSV fake and posts to POST /v1/internal/import.
// The lodash and django records are SYNTHETIC: real OSV ids and CVE aliases
// for lodash, fixture ids for django, ranges written for this test.
const ROOT = join(import.meta.dirname, "..", "..");
const LOCAL_CLI = "node packages/cli/bin/tocsin.js";
const TOKEN = "tok-fixture-launch-32";

function lodash(id: string, cve: string, fixed: string): Record<string, unknown> {
  return { ...osvRecord(id, "npm", "lodash", { fixed, published: "2020-07-15T00:00:00Z" }), aliases: [cve] };
}
const NPM = [
  lodash("GHSA-p6mc-m468-83gw", "CVE-2020-8203", "4.17.19"),
  lodash("GHSA-35jh-r3h4-6jhm", "CVE-2021-23337", "4.17.21"),
  osvRecord("GHSA-tcs3-2npm-0001", "npm", "tcs32-other", { published: "2019-01-01T00:00:00Z" }),
  osvRecord("MAL-2026-3201", "npm", "tcs32-malware"),
];
const PYPI = Array.from({ length: 11 }, (_, i) => osvRecord(`PYSEC-2099-${i + 1}`, "PyPI", "django", { fixed: "3.2.99", published: "2021-04-06T00:00:00Z" }));

// The OSV GCS layout: <eco>/all.zip and <eco>/modified_id.csv ("<modified>,<id>" lines).
function csv(records: Record<string, unknown>[], extra = 0): string {
  const ids = [...records.map((r) => String(r.id)), ...Array.from({ length: extra }, (_, i) => `GHSA-tcs3-2xtr-${String(i).padStart(4, "0")}`)];
  return ids.map((id) => `2026-10-01T00:00:00Z,${id}`).join("\n") + "\n";
}

let osv: Server;
let osvBase = "";
const files = new Map<string, Uint8Array | string>();
beforeAll(async () => {
  const r = spawnSync("npx", ["tsc", "-p", "packages/cli/tsconfig.build.json"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`CLI build failed: ${r.stdout}${r.stderr}`);
  files.set("/npm/all.zip", await buildZip(NPM.map((x) => jsonEntry(x))));
  files.set("/PyPI/all.zip", await buildZip(PYPI.map((x) => jsonEntry(x))));
  osv = createServer((req, res) => {
    const body = files.get(req.url ?? "");
    if (body === undefined) {
      res.writeHead(404);
      res.end("osv fake: not found");
      return;
    }
    res.writeHead(200);
    res.end(body);
  });
  await new Promise<void>((done) => osv.listen(0, "127.0.0.1", done));
  osvBase = `http://127.0.0.1:${(osv.address() as AddressInfo).port}`;
  return () => new Promise<void>((done) => osv.close(() => done()));
});

let w: LocalWorker;
beforeEach(async () => {
  files.set("/npm/modified_id.csv", csv(NPM));
  files.set("/PyPI/modified_id.csv", csv(PYPI));
  w = await startLocalWorker({ text: { IMPORT_TOKEN: TOKEN } });
  // This fixture world has two enabled OSV ecosystems.
  await w.db.prepare("UPDATE sources SET config_json = ? WHERE id = 'osv'").bind(JSON.stringify({ ecosystems: ["npm", "PyPI"] })).run();
});
afterEach(async () => {
  await w.dispose();
});

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out }));
  });
}

async function backfill(eco: string): Promise<void> {
  // The command line of .github/workflows/backfill.yml.
  const r = await run("node", ["scripts/backfill/run.mjs", "--ecosystem", eco, "--batch", "500"], { TOCSIN_URL: w.url, IMPORT_TOKEN: TOKEN, OSV_BASE: osvBase });
  expect(r.code, r.out).toBe(0);
}

const launch = (env: Record<string, string> = {}) =>
  run("bash", ["scripts/launch-check.sh"], { BASE_URL: w.url, TOCSIN_CLI: LOCAL_CLI, OSV_BASE: osvBase, ...env });

describe("launch-check.sh coverage checks (COVERAGE_CHECK=1)", () => {
  it("after the backfill of npm and PyPI, the three coverage checks pass: 8 of 8, exit 0", async () => {
    await backfill("npm");
    await backfill("PyPI");
    const r = await launch({ COVERAGE_CHECK: "1" });
    expect(r.out).toContain("ok cov-lodash");
    expect(r.out).toContain("ok cov-django");
    expect(r.out).toContain("ok cov-count");
    expect(r.out).toContain("launch-check: 8 of 8 passed");
    expect(r.code, r.out).toBe(0);
    expect(w.unknownUrls).toEqual([]);
  });

  it("with the lodash advisory CVE-2021-23337 removed, cov-lodash FAILs and the script exits 1", async () => {
    await backfill("npm");
    await backfill("PyPI");
    const sub = "SELECT advisory_id FROM advisory_sources WHERE source = 'osv' AND source_id = 'GHSA-35jh-r3h4-6jhm'";
    await w.db.prepare(`DELETE FROM advisories WHERE id IN (${sub})`).run();
    await w.db.prepare(`DELETE FROM advisory_sources WHERE source = 'osv' AND source_id = 'GHSA-35jh-r3h4-6jhm'`).run();
    const r = await launch({ COVERAGE_CHECK: "1" });
    expect(r.out).toMatch(/FAIL cov-lodash: .*CVE-2021-23337/);
    expect(r.out).toContain("ok cov-django");
    expect(r.out).toContain("launch-check: 7 of 8 passed");
    expect(r.code).toBe(1);
  });

  it("fewer than COV_DJANGO_MIN django advisories FAILs cov-django", async () => {
    await backfill("npm");
    await backfill("PyPI");
    const r = await launch({ COVERAGE_CHECK: "1", COV_DJANGO_MIN: "12" });
    expect(r.out).toMatch(/FAIL cov-django: .*11 affected/);
    expect(r.code).toBe(1);
  });

  it("an ecosystem under 90% of OSV's non-MAL id count FAILs cov-count by name", async () => {
    await backfill("npm");
    await backfill("PyPI");
    // OSV lists 9 more npm ids than were imported: 3 of 12 is 25%.
    files.set("/npm/modified_id.csv", csv(NPM, 9));
    const r = await launch({ COVERAGE_CHECK: "1" });
    expect(r.out).toMatch(/FAIL cov-count: .*npm 3 of 12/);
    expect(r.out).not.toMatch(/FAIL cov-count: .*PyPI/);
    expect(r.code).toBe(1);
  });

  it("with the flag unset, the script runs its five checks as before", async () => {
    const r = await launch();
    expect(r.out).toContain("launch-check: 5 of 5 passed");
    expect(r.out).not.toContain("cov-");
    expect(r.code, r.out).toBe(0);
  });
});
