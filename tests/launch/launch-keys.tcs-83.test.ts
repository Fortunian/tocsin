import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type LocalWorker, startLocalWorker } from "./local-worker.tcs-14";

// TCS-83: the opt-in keys-signup check of scripts/launch-check.sh, against the
// real worker in Miniflare. MAIL_TRANSPORT=fake makes the worker's mail seam
// write to its KV outbox: 0 network calls, no real mail.

const ROOT = join(import.meta.dirname, "..", "..");
const LOCAL_CLI = "node packages/cli/bin/tocsin.js";

function runCheck(baseUrl: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const base: Record<string, string | undefined> = { ...process.env, BASE_URL: baseUrl, TOCSIN_CLI: LOCAL_CLI };
    delete base.KEYS_CHECK;
    delete base.KEYS_CHECK_EMAIL;
    delete base.COVERAGE_CHECK;
    const p = spawn("bash", ["scripts/launch-check.sh"], { cwd: ROOT, env: { ...base, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out }));
  });
}

let w: LocalWorker | undefined;
beforeAll(() => {
  const r = spawnSync("npx", ["tsc", "-p", "packages/cli/tsconfig.build.json"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`CLI build failed: ${r.stdout}${r.stderr}`);
});
afterEach(async () => {
  await w?.dispose();
  w = undefined;
});

describe("launch-check keys-signup", () => {
  it("K1: KEYS_CHECK=1 with a test address: ok keys-signup, 6 of 6 passed, exit 0, one mail in the fake outbox", async () => {
    w = await startLocalWorker({ text: { MAIL_TRANSPORT: "fake" } });
    const email = `launch-${crypto.randomUUID()}@example.test`;
    const r = await runCheck(w.url, { KEYS_CHECK: "1", KEYS_CHECK_EMAIL: email });
    expect(r.out).toContain("ok keys-signup");
    expect(r.out).toContain("launch-check: 6 of 6 passed");
    expect(r.code, r.out).toBe(0);
    const kv = await w.mf.getKVNamespace("CURSORS");
    const box = JSON.parse((await kv.get(`mail:fake:${email}`, "text")) ?? "[]") as unknown[];
    expect(box).toHaveLength(1);
    expect(w.unknownUrls).toEqual([]);
  });

  it("K2: a worker with no mail transport answers 503: FAIL keys-signup with HTTP 503, exit 1", async () => {
    w = await startLocalWorker();
    const r = await runCheck(w.url, { KEYS_CHECK: "1", KEYS_CHECK_EMAIL: `launch-${crypto.randomUUID()}@example.test` });
    expect(r.out).toMatch(/FAIL keys-signup: POST \/v1\/keys: HTTP 503/);
    expect(r.out).toContain("launch-check: 5 of 6 passed");
    expect(r.code).toBe(1);
  });

  it("K3: KEYS_CHECK=1 with no KEYS_CHECK_EMAIL fails preflight, exit 1", async () => {
    const r = await runCheck("http://127.0.0.1:9", { KEYS_CHECK: "1" });
    expect(r.out).toContain("FAIL preflight: KEYS_CHECK_EMAIL must be set when KEYS_CHECK=1");
    expect(r.code).toBe(1);
  });

  it("K4: without KEYS_CHECK there is no keys-signup line, 5 of 5 passed, and no mail", async () => {
    w = await startLocalWorker({ text: { MAIL_TRANSPORT: "fake" } });
    const r = await runCheck(w.url);
    expect(r.out).not.toContain("keys-signup");
    expect(r.out).toContain("launch-check: 5 of 5 passed");
    expect(r.code, r.out).toBe(0);
    const kv = await w.mf.getKVNamespace("CURSORS");
    expect((await kv.list({ prefix: "mail:fake:" })).keys).toEqual([]);
  });
});
