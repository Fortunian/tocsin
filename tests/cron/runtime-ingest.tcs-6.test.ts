import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { NODE_CURSOR_KEY } from "../../src/ingest/node-runtime";
import { PHP_CURSOR_KEY } from "../../src/ingest/php-runtime";
import nodePost from "../fixtures/node-runtime/2026-10-21.html?raw";
import nodeIndex from "../fixtures/node-runtime/index.json?raw";
import nodeFeed from "../fixtures/node-runtime/vulnerability.xml?raw";
import phpNews from "../fixtures/php-runtime/2026-10-21.html?raw";
import ghsa6wmf from "../fixtures/php-runtime/GHSA-6wmf-4rv5-p3rp.json?raw";
import ghsaW8hw from "../fixtures/php-runtime/GHSA-w8hw-w9fx-j79w.json?raw";
import phpReleases from "../fixtures/php-runtime/releases.xml?raw";
import { createRuntimeFake } from "../ingest/runtime-fake.tcs-6";

// The production entry: worker.scheduled (src/index.ts) -> runCron -> defaultRegistry,
// with the default source config (real nodejs.org / php.net / api.github.com URLs)
// answered by the URL-map fake through a globalThis.fetch mock.
const ROUTES = {
  "https://nodejs.org/en/feed/vulnerability.xml": nodeFeed,
  "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases": nodePost,
  "https://nodejs.org/dist/index.json": nodeIndex,
  "https://www.php.net/index.php": phpNews,
  "https://www.php.net/releases/feed.php": phpReleases,
  "https://api.github.com/repos/php/php-src/security-advisories/GHSA-w8hw-w9fx-j79w": ghsaW8hw,
  "https://api.github.com/repos/php/php-src/security-advisories/GHSA-6wmf-4rv5-p3rp": ghsa6wmf,
};
// Both cursors start before the 2026-10-21 posts, so only those posts are read.
const START = "2026-10-01T00:00:00Z";

interface CheckAnswer {
  affected: { dependency: { ecosystem: string; version: string }; cve_ids: string[]; action: string; fixed_in: string | null }[];
}

async function scheduledWithFake() {
  const fake = createRuntimeFake(ROUTES);
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "*/10 * * * *", scheduledTime: Date.now() }), env, ctx);
  await waitOnExecutionContext(ctx);
  spy.mockRestore();
  return fake;
}

async function status(id: string) {
  return env.DB.prepare("SELECT last_ok_at, last_error FROM sources WHERE id = ?").bind(id).first<{ last_ok_at: string | null; last_error: string | null }>();
}

async function check(ip: string, runtimes: Record<string, string>): Promise<CheckAnswer> {
  const res = await exports.default.fetch("https://tocsin.test/v1/check", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
    body: JSON.stringify({ runtimes }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as CheckAnswer;
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await env.DB.prepare("UPDATE sources SET enabled = 0").run();
  await env.DB.prepare(
    "UPDATE sources SET enabled = 1, config_json = '{}', last_ok_at = NULL, last_error = NULL WHERE id IN ('node-runtime', 'php-runtime')",
  ).run();
  await env.DB.prepare("DELETE FROM advisories WHERE id IN (SELECT advisory_id FROM advisory_sources WHERE source IN ('node-runtime', 'php-runtime'))").run();
  await env.DB.prepare("DELETE FROM advisory_sources WHERE source IN ('node-runtime', 'php-runtime')").run();
  await env.CURSORS.put(NODE_CURSOR_KEY, START);
  await env.CURSORS.put(PHP_CURSOR_KEY, START);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime ingesters through worker.scheduled", () => {
  it("C1: both runtime sources run from the default registry, mark ok, and store node and php advisories", async () => {
    const fake = await scheduledWithFake();
    for (const id of ["node-runtime", "php-runtime"]) {
      const s = await status(id);
      expect(s?.last_error, id).toBeNull();
      expect(s?.last_ok_at, id).not.toBeNull();
    }
    const rows = await env.DB.prepare(
      "SELECT a.ecosystem, COUNT(*) AS n FROM advisories a JOIN advisory_sources s ON s.advisory_id = a.id WHERE s.source IN ('node-runtime', 'php-runtime') GROUP BY a.ecosystem ORDER BY a.ecosystem",
    ).all<{ ecosystem: string; n: number }>();
    expect(rows.results).toEqual([
      { ecosystem: "node", n: 10 },
      { ecosystem: "php", n: 2 },
    ]);
    expect(new Set(fake.urls())).toEqual(new Set(Object.keys(ROUTES)));
    expect(await env.CURSORS.get(NODE_CURSOR_KEY)).toBe("2026-10-21T22:00:00Z");
    expect(await env.CURSORS.get(PHP_CURSOR_KEY)).toBe("2026-10-21T00:35:26Z");
  });

  it("C2: after the cron, /v1/check flags node 24.10.0 and php 8.3.20, and not node 24.22.1", async () => {
    await scheduledWithFake();
    const hit = await check("192.0.2.61", { node: "24.10.0", php: "8.3.20" });
    const cves = hit.affected.flatMap((a) => a.cve_ids);
    expect(cves).toContain("CVE-2026-111497");
    expect(cves).toContain("CVE-2026-109618");
    expect(cves).toContain("CVE-2026-109619");
    const brotli = hit.affected.find((a) => a.cve_ids.includes("CVE-2026-111497"))!;
    expect(brotli.action).toBe("Upgrade node to 22.23.4 (22.x), 24.22.1 (24.x) or 26.12.1 (26.x) or later.");

    const fixed = await check("192.0.2.62", { node: "24.22.1" });
    expect(fixed.affected.flatMap((a) => a.cve_ids)).not.toContain("CVE-2026-111497");
  });

  it("C4 F1: after the cron, /v1/check flags php 8.1.30 (no fix line) with fixed_in 8.2.35, and not php 8.2.35", async () => {
    await scheduledWithFake();
    const old = await check("192.0.2.63", { php: "8.1.30" });
    const hit = old.affected.find((a) => a.cve_ids.includes("CVE-2026-109618"));
    expect(hit?.fixed_in).toBe("8.2.35");
    expect(hit?.action).toContain("8.1 and older");

    const fixed = await check("192.0.2.64", { php: "8.2.35" });
    expect(fixed.affected.flatMap((a) => a.cve_ids)).not.toContain("CVE-2026-109618");
  });
});
