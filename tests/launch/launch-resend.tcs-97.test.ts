import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type LocalWorker, startLocalWorker } from "./local-worker.tcs-14";

// TCS-97: a worker built from migrations/ selects Resend (migration 0031), and
// the keys-signup check of scripts/launch-check.sh accepts the header
// Tocsin-Mail-Dkim: provider. Real worker in Miniflare, fake mailer
// (MAIL_TRANSPORT=fake): 0 network calls, no real mail.

const ROOT = join(import.meta.dirname, "..", "..");
const LOCAL_CLI = "node packages/cli/bin/tocsin.js";
const FIXTURE = `fixture-dkim-key-not-a-real-key-${crypto.randomUUID()}`;

function runCheck(baseUrl: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
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

describe("launch-check keys-signup with Resend", () => {
  it("L1: the migrated settings row mail.provider is resend", async () => {
    w = await startLocalWorker({ text: { MAIL_TRANSPORT: "fake" } });
    const row = await w.db.prepare("SELECT value FROM settings WHERE key = 'mail.provider'").first<{ value: string }>();
    expect(row?.value).toBe("resend");
  });

  it("L2: ok keys-signup (dkim signed by the provider), 6 of 6, exit 0; the mail has no dkim field even with DKIM_PRIVATE_KEY set", async () => {
    w = await startLocalWorker({ text: { MAIL_TRANSPORT: "fake", DKIM_PRIVATE_KEY: FIXTURE } });
    const email = `launch-${crypto.randomUUID()}@example.test`;
    const r = await runCheck(w.url, { KEYS_CHECK: "1", KEYS_CHECK_EMAIL: email });
    expect(r.out).toContain("ok keys-signup (dkim signed by the provider)");
    expect(r.out).toContain("launch-check: 6 of 6 passed");
    expect(r.code, r.out).toBe(0);
    const kv = await w.mf.getKVNamespace("CURSORS");
    const box = JSON.parse((await kv.get(`mail:fake:${email}`, "text")) ?? "[]") as Record<string, unknown>[];
    expect(box).toHaveLength(1);
    expect(Object.keys(box[0]).filter((k) => k.startsWith("dkim_"))).toEqual([]);
    const warning = await w.db.prepare("SELECT last_warning FROM sources WHERE id = 'mail'").first<{ last_warning: string | null }>();
    expect(warning?.last_warning).toBeNull();
    expect(r.out).not.toContain(FIXTURE);
    expect(w.unknownUrls).toEqual([]);
  });
});
