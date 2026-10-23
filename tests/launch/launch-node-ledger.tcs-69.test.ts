import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NODE_PARSER_REV } from "../../src/ingest/node-runtime";
import { type LocalWorker, startLocalWorker } from "./local-worker.tcs-14";

// TCS-69: the launch gate (scripts/launch-check.sh) against the real worker in
// Miniflare whose node-runtime post ledger holds a terminal empty post (the
// 2019 "no updates" post) and a pending post that is not due. The node-runtime
// row reads the whole feed (backfill_days 4000) and every other feed post has
// an ok row, so a second cron run reads only the newest post. A read of the
// empty or the pending post would get the fake's 599 for an unknown URL and fail
// the source, so `ok status` and unknownUrls = [] prove neither was read.
const ROOT = join(import.meta.dirname, "..", "..");
const LOCAL_CLI = "node packages/cli/bin/tocsin.js";
const BASE = "https://nodejs.org/en/blog/vulnerability/";
const NO_UPDATES = `${BASE}september-2019-openssl-no-updates`;
const PENDING = `${BASE}june-2026-security-releases`;
// The rows were read by the current parser revision (TCS-76 bumped it).
const PARSER_REV = NODE_PARSER_REV;

// The Security Release items of the recorded feed (the rule of parseNodeFeed:
// title match, pubDate as RFC3339 UTC without millis).
const feedXml = readFileSync(join(ROOT, "tests", "fixtures", "node-runtime", "vulnerability.xml"), "utf8");
const RELEASES = [...feedXml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
  .map((m) => ({
    title: /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(m[1])![1],
    link: /<link>([\s\S]*?)<\/link>/.exec(m[1])![1].trim(),
    published: new Date(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1])![1]).toISOString().replace(/\.\d{3}Z$/, "Z"),
  }))
  .filter((p) => p.title.toLowerCase().includes("security release"));

function runCheck(baseUrl: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn("bash", ["scripts/launch-check.sh"], { cwd: ROOT, env: { ...process.env, BASE_URL: baseUrl, TOCSIN_CLI: LOCAL_CLI } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out }));
  });
}

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

describe("launch-check.sh with a node-runtime ledger of empty and pending posts", () => {
  it("status passes, exit 0, no unknown URL, and /v1/status shows empty 1 and pending 1", async () => {
    expect(RELEASES).toHaveLength(48);
    expect(RELEASES.map((p) => p.link)).toEqual(expect.arrayContaining([NO_UPDATES, PENDING]));
    const now = new Date().toISOString();
    const insert = w.db.prepare(
      "INSERT INTO node_runtime_posts (url, published, state, attempts, parser_rev, next_check_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?) ON CONFLICT(url) DO NOTHING",
    );
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    await w.db.batch(
      RELEASES.map((p) =>
        p.link === NO_UPDATES
          ? insert.bind(p.link, p.published, "empty", PARSER_REV, null, now)
          : p.link === PENDING
            ? insert.bind(p.link, p.published, "pending", PARSER_REV, tomorrow, now)
            : insert.bind(p.link, p.published, "ok", PARSER_REV, null, now),
      ),
    );
    // The seed cron read the July and October posts: their rows are ok already.
    const seeded = await w.db.prepare("SELECT state, COUNT(*) AS n FROM node_runtime_posts GROUP BY state ORDER BY state").all<{ state: string; n: number }>();
    expect(seeded.results).toEqual([
      { state: "empty", n: 1 },
      { state: "ok", n: 46 },
      { state: "pending", n: 1 },
    ]);
    await w.db.prepare("UPDATE sources SET config_json = json_set(config_json, '$.backfill_days', 4000, '$.max_posts', 20) WHERE id = 'node-runtime'").run();

    const before = (await w.db.prepare("SELECT last_run_at FROM sources WHERE id = 'node-runtime'").first<{ last_run_at: string }>())!.last_run_at;
    await new Promise((r) => setTimeout(r, 5));
    const worker = await w.mf.getWorker();
    await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: new Date() });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const row = await w.db.prepare("SELECT last_run_at FROM sources WHERE id = 'node-runtime'").first<{ last_run_at: string }>();
      if (row && row.last_run_at > before) break;
      if (Date.now() > deadline) throw new Error("the second cron run did not run node-runtime");
      await new Promise((r) => setTimeout(r, 100));
    }
    const node = await w.db.prepare("SELECT last_error, last_ok_at, last_run_at FROM sources WHERE id = 'node-runtime'").first<{ last_error: string | null; last_ok_at: string; last_run_at: string }>();
    expect(node?.last_error).toBeNull();
    expect(node?.last_ok_at).toBe(node?.last_run_at);
    expect(w.unknownUrls).toEqual([]);

    const r = await runCheck(w.url);
    expect(r.out).toContain("ok status");
    expect(r.out).toContain("launch-check: 5 of 5 passed");
    expect(r.code, r.out).toBe(0);

    const res = await fetch(`${w.url}/v1/status`);
    const src = ((await res.json()) as { sources: { id: string; ledger?: Record<string, number> }[] }).sources.find((s) => s.id === "node-runtime");
    expect(src?.ledger).toEqual({ ok: 46, empty: 1, pending: 1, failed_retrying: 0, failed_terminal: 0 });
    expect(w.unknownUrls).toEqual([]);
  });
});
