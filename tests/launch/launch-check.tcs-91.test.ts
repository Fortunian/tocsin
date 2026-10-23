import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildZip, jsonEntry, osvRecord } from "../backfill/zip-fixture.tcs-32";
import { type LocalWorker, startLocalWorker } from "./local-worker.tcs-14";

// TCS-91: cov-count in scripts/launch-check.sh takes the skipped ids (withdrawn
// and MAL-, backfill.skipped via /v1/status coverage) out of the denominator,
// and an ecosystem under COV_SMALL_IDS OSV ids needs every non-skipped id.
// The real worker runs in Miniflare; OSV is a local fake. The Pub world is the
// one of the ticket: 14 ids, 2 of them withdrawn. The two withdrawn ids are the
// real ones the ticket names; the other ids and every record body are SYNTHETIC.
// Only the cov-count lines are asserted, so the CLI is `true` (cli-connect FAILs).
const ROOT = join(import.meta.dirname, "..", "..");
const TOKEN = "tok-fixture-launch-91";
const WITHDRAWN = ["GHSA-9f2c-xxfm-32mj", "GHSA-jwpw-q68h-r678"];
const PUB = [
  ...Array.from({ length: 12 }, (_, i) => osvRecord(`GHSA-tcs9-1pub-${String(i).padStart(4, "0")}`, "Pub", "tcs91_pkg", { published: "2022-01-01T00:00:00Z" })),
  ...WITHDRAWN.map((id) => osvRecord(id, "Pub", "tcs91_pkg", { withdrawn: true })),
];

// The OSV GCS layout: <eco>/modified_id.csv has "<modified>,<id>" lines.
const csvOf = (ids: string[]) => ids.map((id) => `2026-10-01T00:00:00Z,${id}`).join("\n") + "\n";
const fakeIds = (eco: string, n: number) => Array.from({ length: n }, (_, i) => `GHSA-tcs9-${eco.toLowerCase()}-${String(i).padStart(4, "0")}`);

let osv: Server;
let osvBase = "";
const files = new Map<string, Uint8Array | string>();
beforeAll(async () => {
  files.set("/Pub/all.zip", await buildZip(PUB.map((x) => jsonEntry(x))));
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
  files.set("/Pub/modified_id.csv", csvOf(PUB.map((r) => String(r.id))));
  w = await startLocalWorker({ text: { IMPORT_TOKEN: TOKEN } });
  await ecosystems(["Pub"]);
});
afterEach(async () => {
  await w.dispose();
});

async function ecosystems(list: string[]): Promise<void> {
  await w.db.prepare("UPDATE sources SET config_json = ? WHERE id = 'osv'").bind(JSON.stringify({ ecosystems: list })).run();
}

// A backfill row as POST /v1/internal/import writes it at the end of a run.
async function seedBackfill(eco: string, imported: number, skipped: number): Promise<void> {
  await w.db
    .prepare("INSERT INTO backfill (ecosystem, started_at, done_at, imported, unchanged, skipped, last_id, coverage_since) VALUES (?, '2026-10-23T00:00:00Z', '2026-10-23T01:00:00Z', ?, 0, ?, 'GHSA-zzzz', '2022-01-01T00:00:00Z')")
    .bind(eco, imported, skipped)
    .run();
}

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

const launch = (env: Record<string, string> = {}, base = w.url) =>
  run("bash", ["scripts/launch-check.sh"], { BASE_URL: base, TOCSIN_CLI: "true", OSV_BASE: osvBase, COVERAGE_CHECK: "1", ...env });

const covLines = (out: string) => out.split("\n").filter((l) => /cov-count/.test(l));

describe("launch-check.sh cov-count without the skipped ids (TCS-91)", () => {
  it("Pub 12 of 12: a correct import of 14 OSV ids with 2 withdrawn passes cov-count", async () => {
    // The command line of .github/workflows/backfill.yml.
    const b = await run("node", ["scripts/backfill/run.mjs", "--ecosystem", "Pub", "--batch", "500"], { TOCSIN_URL: w.url, IMPORT_TOKEN: TOKEN, OSV_BASE: osvBase });
    expect(b.code, b.out).toBe(0);
    const r = await launch();
    expect(covLines(r.out), r.out).toContain("cov-count: Pub 12 of 12 (14 OSV ids, 2 skipped, needs all)");
    expect(covLines(r.out), r.out).toContain("ok cov-count");
    expect(w.unknownUrls).toEqual([]);
  });

  it("status coverage skipped: /v1/status carries backfill.skipped, null for a runtime", async () => {
    await seedBackfill("Pub", 12, 2);
    const res = await fetch(`${w.url}/v1/status`);
    expect(res.status).toBe(200);
    const s = (await res.json()) as { coverage: { ecosystem: string; imported: number | null; skipped: number | null }[] };
    const by = new Map(s.coverage.map((c) => [c.ecosystem, c]));
    expect(by.get("Pub")?.imported).toBe(12);
    expect(by.get("Pub")?.skipped).toBe(2);
    expect(by.get("node")?.skipped).toBeNull();
  });

  it("3 missing non-skipped ids FAIL: Pub 9 of 12, exit 1", async () => {
    await seedBackfill("Pub", 9, 2);
    const r = await launch();
    expect(r.out).toContain("cov-count: Pub 9 of 12 (14 OSV ids, 2 skipped, needs all)");
    expect(r.out).toMatch(/FAIL cov-count: .*Pub 9 of 12/);
    expect(r.out).not.toContain("ok cov-count");
    expect(r.code).toBe(1);
  });

  it("under COV_SMALL_IDS (default 50) every non-skipped id is needed: Pub 11 of 12 FAILs; COV_SMALL_IDS=10 takes the percent rule", async () => {
    await seedBackfill("Pub", 11, 2);
    const r = await launch();
    expect(r.out).toMatch(/FAIL cov-count: .*Pub 11 of 12/);
    const knob = await launch({ COV_SMALL_IDS: "10" });
    expect(covLines(knob.out), knob.out).toContain("cov-count: Pub 11 of 12 (14 OSV ids, 2 skipped, needs 90%)");
    expect(covLines(knob.out), knob.out).toContain("ok cov-count");
  });

  it("the 90 percent rule stays for 50 ids and more: npm 54 of 60 passes, 53 of 60 FAILs, 45 of 50 passes", async () => {
    await ecosystems(["npm"]);
    files.set("/npm/modified_id.csv", csvOf(fakeIds("npm", 60)));
    await seedBackfill("npm", 54, 0);
    const pass = await launch();
    expect(covLines(pass.out), pass.out).toContain("cov-count: npm 54 of 60 (60 OSV ids, 0 skipped, needs 90%)");
    expect(covLines(pass.out), pass.out).toContain("ok cov-count");

    await w.db.prepare("UPDATE backfill SET imported = 53 WHERE ecosystem = 'npm'").run();
    const short = await launch();
    expect(short.out).toMatch(/FAIL cov-count: .*npm 53 of 60/);

    // Exactly COV_SMALL_IDS ids: the percent rule, not "all".
    files.set("/npm/modified_id.csv", csvOf(fakeIds("npm", 50)));
    await w.db.prepare("UPDATE backfill SET imported = 45 WHERE ecosystem = 'npm'").run();
    const edge = await launch();
    expect(covLines(edge.out), edge.out).toContain("cov-count: npm 45 of 50 (50 OSV ids, 0 skipped, needs 90%)");
    expect(covLines(edge.out), edge.out).toContain("ok cov-count");
  });

  it("every id skipped: 0 of 0 passes", async () => {
    files.set("/Pub/modified_id.csv", csvOf(WITHDRAWN.concat("MAL-2026-9101")));
    await seedBackfill("Pub", 0, 3);
    const r = await launch();
    expect(covLines(r.out), r.out).toContain("cov-count: Pub 0 of 0 (3 OSV ids, 3 skipped, needs all)");
    expect(covLines(r.out), r.out).toContain("ok cov-count");
  });

  it("a coverage row with no skipped count FAILs cov-count by name, never read as 0", async () => {
    const fake = createServer((req, res) => {
      if (req.url === "/v1/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sources: [], cursor: 0, coverage: [{ ecosystem: "Pub", since: null, complete: true, imported: 12 }] }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
    try {
      const r = await launch({}, `http://127.0.0.1:${(fake.address() as AddressInfo).port}`);
      expect(r.out).toMatch(/FAIL cov-count: .*Pub \(no skipped count in \/v1\/status\)/);
      expect(r.out).not.toContain("ok cov-count");
      expect(r.code).toBe(1);
    } finally {
      await new Promise<void>((done) => fake.close(() => done()));
    }
  });

  it("COV_SMALL_IDS that is not a whole number FAILs preflight, exit 1", async () => {
    const r = await launch({ COV_SMALL_IDS: "abc" });
    expect(r.out).toContain("FAIL preflight: COV_SMALL_IDS must be a whole number, got 'abc'");
    expect(r.code).toBe(1);
  });
});
