import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type LocalWorker, startLocalWorker } from "./local-worker.tcs-14";

// The launch gate (scripts/launch-check.sh) against a real worker on
// localhost, seeded with the 2026-10-21 fixtures through worker.scheduled.
// Each test boots its own worker with fresh storage, so no test depends on another.

const ROOT = join(import.meta.dirname, "..", "..");
const LOCAL_CLI = "node packages/cli/bin/tocsin.js";

// Async spawn, so a server in this process (L7) can still answer the script.
function runCheck(baseUrl: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn("bash", ["scripts/launch-check.sh"], {
      cwd: ROOT,
      env: { ...process.env, BASE_URL: baseUrl, TOCSIN_CLI: LOCAL_CLI, ...env },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

const isoHoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

let w: LocalWorker;

beforeAll(() => {
  const r = spawnSync("npx", ["tsc", "-p", "packages/cli/tsconfig.build.json"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`CLI build failed: ${r.stdout}${r.stderr}`);
});
beforeEach(async () => {
  w = await startLocalWorker();
});
afterEach(async () => {
  await w.dispose();
});

describe("scripts/launch-check.sh against a seeded local worker", () => {
  it("L1 + L6: all five checks pass, exit 0, and the seed made 0 calls outside the fixtures", async () => {
    const r = await runCheck(w.url);
    expect(r.out).toContain("ok node-cve");
    expect(r.out).toContain("ok php-cve");
    expect(r.out).toContain("ok check-node");
    expect(r.out).toContain("ok status");
    expect(r.out).toContain("ok cli-connect");
    expect(r.out).toContain("launch-check: 5 of 5 passed");
    expect(r.code, r.out + r.err).toBe(0);
    expect(w.unknownUrls).toEqual([]);
  });

  it("L2: with the node advisory removed, node-cve and check-node FAIL and the script exits 1", async () => {
    const sub = "SELECT id FROM advisories WHERE cve_primary = 'CVE-2026-111497'";
    const before = await w.db.prepare(`SELECT COUNT(*) AS n FROM advisories WHERE cve_primary = 'CVE-2026-111497'`).first<{ n: number }>();
    expect(before?.n).toBeGreaterThan(0);
    await w.db.prepare(`DELETE FROM advisory_sources WHERE advisory_id IN (${sub})`).run();
    await w.db.prepare(`DELETE FROM advisories WHERE id IN (${sub})`).run();

    const r = await runCheck(w.url);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL node-cve: .*404/);
    expect(r.out).toContain("FAIL check-node");
    expect(r.out).toContain("ok php-cve");
    expect(r.out).toContain("launch-check: 3 of 5 passed");
  });

  it("L3: a source 25 h stale FAILs status by name; 23 h stale passes", async () => {
    await w.db.prepare("UPDATE sources SET last_ok_at = ? WHERE id = 'php-runtime'").bind(isoHoursAgo(25)).run();
    const stale = await runCheck(w.url);
    expect(stale.code).toBe(1);
    expect(stale.out).toMatch(/FAIL status: .*php-runtime/);
    expect(stale.out).not.toMatch(/FAIL status: .*node-runtime/);

    await w.db.prepare("UPDATE sources SET last_ok_at = ? WHERE id = 'php-runtime'").bind(isoHoursAgo(23)).run();
    const fresh = await runCheck(w.url);
    expect(fresh.out).toContain("ok status");
    expect(fresh.code, fresh.out).toBe(0);
  });

  it("L4: a fresh source with no first run WARNs by name and passes; one whose run left an error FAILs", async () => {
    // A source added in the last deploy: no last_ok_at and no error yet.
    await w.db.prepare("UPDATE sources SET last_ok_at = NULL, last_error = NULL WHERE id = 'node-runtime'").run();
    const fresh = await runCheck(w.url);
    expect(fresh.out).toMatch(/^WARN status: node-runtime has not succeeded yet/m);
    expect(fresh.out).not.toContain("WARN status: php-runtime");
    expect(fresh.out).toContain("ok status");
    expect(fresh.out).toContain("launch-check: 5 of 5 passed");
    expect(fresh.code, fresh.out).toBe(0);

    // The same source after a failed first run: last_error is set, so status FAILs.
    await w.db.prepare("UPDATE sources SET last_error = 'HTTP 503' WHERE id = 'node-runtime'").run();
    const failed = await runCheck(w.url);
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/FAIL status: .*node-runtime \(last error: HTTP 503\)/);
    expect(failed.out).not.toMatch(/FAIL status: .*php-runtime/);
    expect(failed.out).not.toContain("WARN status: node-runtime");
  });

  it("L4b: a source that succeeded once but has a last_error now FAILs even with a fresh last_ok_at", async () => {
    await w.db.prepare("UPDATE sources SET last_ok_at = ?, last_error = 'HTTP 599' WHERE id = 'php-runtime'").bind(isoHoursAgo(1)).run();
    const r = await runCheck(w.url);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL status: .*php-runtime \(last error: HTTP 599\)/);
    expect(r.out).not.toMatch(/FAIL status: .*node-runtime/);
  });

  it("L5: a CLI that prints no MCP block FAILs cli-connect; the four HTTP checks still pass", async () => {
    const r = await runCheck(w.url, { TOCSIN_CLI: `node -e "console.log('hello')"` });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL cli-connect");
    for (const c of ["node-cve", "php-cve", "check-node", "status"]) expect(r.out).toContain(`ok ${c}`);
    expect(r.out).toContain("launch-check: 4 of 5 passed");

    // The real CLI's block names https://mcp.tocsin.sh/mcp, not this URL.
    const other = await runCheck(w.url, { MCP_URL: "https://mcp.example.test/mcp" });
    expect(other.code).toBe(1);
    expect(other.out).toMatch(/FAIL cli-connect: .*no MCP block for https:\/\/mcp\.example\.test\/mcp/);
  });

  it("L7: a BASE_URL with a trailing slash passes; a host that answers HTML FAILs each HTTP check with 'not JSON'", async () => {
    const slash = await runCheck(`${w.url}/`);
    expect(slash.out).toContain("launch-check: 5 of 5 passed");
    expect(slash.code, slash.out).toBe(0);

    const html = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>proxy error</body></html>");
    });
    await new Promise<void>((r) => html.listen(0, "127.0.0.1", r));
    try {
      const port = (html.address() as AddressInfo).port;
      const r = await runCheck(`http://127.0.0.1:${port}`);
      expect(r.code).toBe(1);
      for (const c of ["node-cve", "php-cve", "check-node", "status"]) expect(r.out).toMatch(new RegExp(`FAIL ${c}: .*not JSON`));
      expect(r.out).toContain("launch-check: 1 of 5 passed");
    } finally {
      await new Promise((r) => html.close(r));
    }
  });
});
