import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type LocalWorker, startLocalWorker } from "./local-worker.tcs-14";

// TCS-94: the keys-signup check of scripts/launch-check.sh reads the
// Tocsin-Mail-Dkim header of POST /v1/keys. Real worker in Miniflare, fake
// mailer (MAIL_TRANSPORT=fake): 0 network calls, no real mail.

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

async function outbox(lw: LocalWorker, email: string): Promise<Record<string, unknown>[]> {
  const kv = await lw.mf.getKVNamespace("CURSORS");
  return JSON.parse((await kv.get(`mail:fake:${email}`, "text")) ?? "[]") as Record<string, unknown>[];
}

const mailWarning = async (lw: LocalWorker) =>
  (await lw.db.prepare("SELECT last_warning FROM sources WHERE id = 'mail'").first<{ last_warning: string | null }>())?.last_warning;

let w: LocalWorker | undefined;
beforeAll(() => {
  const r = spawnSync("npx", ["tsc", "-p", "packages/cli/tsconfig.build.json"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`CLI build failed: ${r.stdout}${r.stderr}`);
});
afterEach(async () => {
  await w?.dispose();
  w = undefined;
});

describe("launch-check keys-signup DKIM", () => {
  it("L1: secret set: ok keys-signup (dkim signed), 6 of 6, exit 0; the mail carries the dkim fields; no warning", async () => {
    w = await startLocalWorker({ text: { MAIL_TRANSPORT: "fake", DKIM_PRIVATE_KEY: FIXTURE } });
    const email = `launch-${crypto.randomUUID()}@example.test`;
    const r = await runCheck(w.url, { KEYS_CHECK: "1", KEYS_CHECK_EMAIL: email });
    expect(r.out).toContain("ok keys-signup (dkim signed)");
    expect(r.out).toContain("launch-check: 6 of 6 passed");
    expect(r.code, r.out).toBe(0);
    const box = await outbox(w, email);
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ dkim_domain: "tocsin.sh", dkim_selector: "mcdkim", dkim_private_key: FIXTURE });
    expect(await mailWarning(w)).toBeNull();
    expect(r.out).not.toContain(FIXTURE);
    expect(w.unknownUrls).toEqual([]);
  });

  it("L2: secret set and a blank selector row: FAIL keys-signup, 5 of 6, exit 1; unsigned mail; the warning names the row", async () => {
    w = await startLocalWorker({ text: { MAIL_TRANSPORT: "fake", DKIM_PRIVATE_KEY: FIXTURE } });
    await w.db.prepare("UPDATE settings SET value = '' WHERE key = 'mail.dkim_selector'").run();
    const email = `launch-${crypto.randomUUID()}@example.test`;
    const r = await runCheck(w.url, { KEYS_CHECK: "1", KEYS_CHECK_EMAIL: email });
    expect(r.out).toMatch(/FAIL keys-signup: POST \/v1\/keys: HTTP 202 but DKIM_PRIVATE_KEY is set/);
    expect(r.out).toContain("launch-check: 5 of 6 passed");
    expect(r.code).toBe(1);
    const box = await outbox(w, email);
    expect(box).toHaveLength(1);
    expect(Object.keys(box[0]).filter((k) => k.startsWith("dkim_"))).toEqual([]);
    expect(await mailWarning(w)).toContain("mail.dkim_selector");
    expect(r.out).not.toContain(FIXTURE);
    expect(w.unknownUrls).toEqual([]);
  });

  it("L3: no secret: ok keys-signup (unsigned ...), exit 0; the warning names DKIM_PRIVATE_KEY", async () => {
    w = await startLocalWorker({ text: { MAIL_TRANSPORT: "fake" } });
    const email = `launch-${crypto.randomUUID()}@example.test`;
    const r = await runCheck(w.url, { KEYS_CHECK: "1", KEYS_CHECK_EMAIL: email });
    expect(r.out).toContain("ok keys-signup (unsigned: DKIM_PRIVATE_KEY not set on the worker)");
    expect(r.out).toContain("launch-check: 6 of 6 passed");
    expect(r.code, r.out).toBe(0);
    expect(await mailWarning(w)).toContain("DKIM_PRIVATE_KEY");
    expect(w.unknownUrls).toEqual([]);
  });
});
