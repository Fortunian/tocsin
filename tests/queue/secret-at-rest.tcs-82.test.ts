// TCS-82 item 2: webhook secrets encrypted at rest. With WEBHOOK_KEK set (the
// api project binds a fixed fixture value in vitest.config.ts), create and
// PATCH store only webhook_secret_enc (AES-GCM, a random IV per row, the list
// id as AAD). The consumer decrypts at sign time. A cron job moves legacy
// plaintext rows and nulls the plaintext column.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app";
import { runCron } from "../../src/cron/run";
import { REENCRYPT_READ_SQL, reencryptWebhookSecrets } from "../../src/cron/reencrypt-secrets";
import type { Env } from "../../src/env";
import { decryptSecret, encryptSecret, importKek } from "../../src/lib/secret-box";
import { runQueue } from "../../src/queue/run";
import { call, newKey, nextIp } from "../routes/keys-helpers.tcs-8";
import { FakeFetch, FakeQueue, deliveryRow, envWith, fakeBatch, hmacHex, insertDelivery, seedAdvisory, seedList } from "./helpers.tcs-11";

const T0 = new Date("2026-10-23T05:00:00.000Z");
const URL_OK = "https://hooks.example.test/at-rest";
const OTHER_KEK = "fixtureotherfixtureotherfixtureotherfixtur0=";

interface SecretRow {
  webhook_secret: string | null;
  webhook_secret_enc: string | null;
}

async function secretRow(id: string): Promise<SecretRow> {
  return (await env.DB.prepare("SELECT webhook_secret, webhook_secret_enc FROM watchlists WHERE id = ?").bind(id).first<SecretRow>())!;
}

async function createHook(key: string): Promise<{ id: string; webhook_secret: string }> {
  const res = await call("POST", "/v1/watchlists", { key, body: { name: "at rest", delivery: "webhook", webhook_url: URL_OK } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; webhook_secret: string };
}

function envNoKek(q: FakeQueue = new FakeQueue()): Env {
  const e = envWith(q);
  return { ...e, WEBHOOK_KEK: undefined };
}

// The production app with an env that has no WEBHOOK_KEK.
async function callNoKek(method: string, path: string, key: string, body: unknown): Promise<Response> {
  const req = new Request(`https://tocsin.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
    body: JSON.stringify(body),
  });
  return app.fetch(req, envNoKek(), createExecutionContext());
}

async function deliver(watchlistId: string, e: Env, f: FakeFetch): Promise<{ advisoryId: string; body: string }> {
  const adv = await seedAdvisory();
  await insertDelivery({ watchlist_id: watchlistId, advisory_id: adv.id, cursor: adv.cursor, status: "pending", next_at: T0.toISOString() });
  const ctx = createExecutionContext();
  await runQueue(fakeBatch([{ watchlist_id: watchlistId, advisory_id: adv.id }]), e, ctx, { fetch: f.fn, now: () => T0 });
  await waitOnExecutionContext(ctx);
  return { advisoryId: adv.id, body: adv.doc_json };
}

async function verifies(call: { headers: Record<string, string>; body: string }, secret: string): Promise<boolean> {
  return call.headers["tocsin-signature"] === `v1=${await hmacHex(secret, `${call.headers["tocsin-timestamp"]}.${call.body}`)}`;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function logged(word: string): boolean {
  return errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(word));
}

describe("a stored secret is unreadable without the KEK", () => {
  it("POST stores webhook_secret NULL and a v1: ciphertext that holds no plaintext; only the KEK and the same list id decrypt it", async () => {
    const { key } = await newKey();
    const made = await createHook(key);
    expect(made.webhook_secret).toMatch(/^whsec_[0-9a-f]{64}$/);

    const row = await secretRow(made.id);
    expect(row.webhook_secret).toBeNull();
    expect(row.webhook_secret_enc).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(row.webhook_secret_enc).not.toContain(made.webhook_secret);
    expect(row.webhook_secret_enc).not.toContain(made.webhook_secret.slice(6));

    const kek = await importKek(env.WEBHOOK_KEK!);
    expect(await decryptSecret(kek, made.id, row.webhook_secret_enc!)).toBe(made.webhook_secret);
    await expect(decryptSecret(await importKek(OTHER_KEK), made.id, row.webhook_secret_enc!)).rejects.toThrow();
    await expect(decryptSecret(kek, "wl_another_list", row.webhook_secret_enc!)).rejects.toThrow();
  });

  it("PATCH to webhook stores only the ciphertext; PATCH to poll clears both columns", async () => {
    const { key } = await newKey();
    const created = await call("POST", "/v1/watchlists", { key, body: { name: "p" } });
    const { id } = (await created.json()) as { id: string };
    const on = await call("PATCH", `/v1/watchlists/${id}`, { key, body: { delivery: "webhook", webhook_url: URL_OK } });
    expect(on.status).toBe(200);
    const { webhook_secret } = (await on.json()) as { webhook_secret: string };
    const row = await secretRow(id);
    expect(row.webhook_secret).toBeNull();
    expect(await decryptSecret(await importKek(env.WEBHOOK_KEK!), id, row.webhook_secret_enc!)).toBe(webhook_secret);

    const off = await call("PATCH", `/v1/watchlists/${id}`, { key, body: { delivery: "poll" } });
    expect(off.status).toBe(200);
    expect(await secretRow(id)).toEqual({ webhook_secret: null, webhook_secret_enc: null });
  });

  it("two encryptions of the same secret text give different ciphertexts (a random IV per row)", async () => {
    const kek = await importKek(env.WEBHOOK_KEK!);
    const a = await encryptSecret(kek, "wl_same", "whsec_fixture_same");
    const b = await encryptSecret(kek, "wl_same", "whsec_fixture_same");
    expect(a).not.toBe(b);
    expect(a.split(":")[1]).not.toBe(b.split(":")[1]);
    expect(await decryptSecret(kek, "wl_same", a)).toBe("whsec_fixture_same");
    expect(await decryptSecret(kek, "wl_same", b)).toBe("whsec_fixture_same");
  });

  it("a KEK that is not 32 bytes of base64 is refused", async () => {
    await expect(importKek("fixture-not-base64!")).rejects.toThrow();
    await expect(importKek(btoa("fixture-16-bytes"))).rejects.toThrow();
  });
});

describe("decrypt only at sign time; signing still verifies", () => {
  it("an encrypted list delivers through runQueue, and the signature verifies with the secret POST returned", async () => {
    const { key } = await newKey();
    const made = await createHook(key);
    const f = new FakeFetch([200]);

    const d = await deliver(made.id, envWith(new FakeQueue()), f);

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].body).toBe(d.body);
    expect(await verifies(f.calls[0], made.webhook_secret)).toBe(true);
    expect(await deliveryRow(made.id, d.advisoryId)).toMatchObject({ status: "delivered", last_code: 200 });
  });

  it("an encrypted row with no KEK at send time: failed, last_error secret_unreadable, 0 fetch calls", async () => {
    const { key } = await newKey();
    const made = await createHook(key);
    const f = new FakeFetch([200]);

    const d = await deliver(made.id, envNoKek(), f);

    expect(f.calls).toHaveLength(0);
    expect(f.dohCalls).toHaveLength(0);
    const row = await env.DB.prepare("SELECT status, last_error FROM deliveries WHERE watchlist_id = ? AND advisory_id = ?")
      .bind(made.id, d.advisoryId)
      .first<{ status: string; last_error: string | null }>();
    expect(row).toEqual({ status: "failed", last_error: "secret_unreadable" });
    expect(logged("kek_missing")).toBe(true);
  });
});

describe("the re-encrypt job", () => {
  it("a legacy plaintext row delivers, is moved (enc set, plaintext NULL), a second run moves 0, and delivery still verifies", async () => {
    const legacy = await seedList({ url: URL_OK });
    const before = await deliver(legacy.id, envWith(new FakeQueue()), new FakeFetch([200]));
    expect(await deliveryRow(legacy.id, before.advisoryId)).toMatchObject({ status: "delivered" });

    const first = await reencryptWebhookSecrets(env);
    expect(first.moved).toBeGreaterThanOrEqual(1);
    const row = await secretRow(legacy.id);
    expect(row.webhook_secret).toBeNull();
    expect(await decryptSecret(await importKek(env.WEBHOOK_KEK!), legacy.id, row.webhook_secret_enc!)).toBe(legacy.secret);

    const second = await reencryptWebhookSecrets(env);
    expect(second.moved).toBe(0);
    expect(await secretRow(legacy.id)).toEqual(row);

    const f = new FakeFetch([200]);
    await deliver(legacy.id, envWith(new FakeQueue()), f);
    expect(f.calls).toHaveLength(1);
    expect(await verifies(f.calls[0], legacy.secret)).toBe(true);
  });

  it("runs from the */10 cron (production entry) after the sweep", async () => {
    const legacy = await seedList({ url: URL_OK });
    expect((await secretRow(legacy.id)).webhook_secret).toBe(legacy.secret);
    const ctx = createExecutionContext();
    await runCron(createScheduledController({ cron: "*/10 * * * *", scheduledTime: T0.getTime() }), envWith(new FakeQueue()), ctx, {});
    await waitOnExecutionContext(ctx);
    const row = await secretRow(legacy.id);
    expect(row.webhook_secret).toBeNull();
    expect(row.webhook_secret_enc).toMatch(/^v1:/);
  });

  it("reencrypt_batch bounds one run", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('webhooks.reencrypt_batch', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    try {
      // Move any plaintext row an earlier test left, one per run, so a and b are the only ones.
      while ((await reencryptWebhookSecrets(env)).moved > 0);
      const a = await seedList({ url: URL_OK });
      const b = await seedList({ url: URL_OK });
      const r = await reencryptWebhookSecrets(env);
      expect(r.moved).toBe(1);
      const left = [await secretRow(a.id), await secretRow(b.id)].filter((x) => x.webhook_secret !== null);
      expect(left).toHaveLength(1);
      expect(r.has_more).toBe(true);
    } finally {
      await env.DB.prepare("UPDATE settings SET value = '500' WHERE key = 'webhooks.reencrypt_batch'").run();
    }
  });
});

describe("KEK unset", () => {
  it("create keeps the plaintext and logs kek_missing; the re-encrypt job moves 0 rows", async () => {
    const { key } = await newKey();
    const res = await callNoKek("POST", "/v1/watchlists", key, { name: "nokek", delivery: "webhook", webhook_url: URL_OK });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string; webhook_secret: string };
    expect(await secretRow(made.id)).toEqual({ webhook_secret: made.webhook_secret, webhook_secret_enc: null });
    expect(logged("kek_missing")).toBe(true);

    const r = await reencryptWebhookSecrets(envNoKek());
    expect(r.moved).toBe(0);
    expect((await secretRow(made.id)).webhook_secret).toBe(made.webhook_secret);

    // A plaintext row still delivers without the KEK.
    const f = new FakeFetch([200]);
    await deliver(made.id, envNoKek(), f);
    expect(f.calls).toHaveLength(1);
    expect(await verifies(f.calls[0], made.webhook_secret)).toBe(true);
  });
});

describe("EXPLAIN", () => {
  it("the re-encrypt read uses idx_watchlists_secret_plain", async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${REENCRYPT_READ_SQL}`).bind(500).all<{ detail: string }>();
    const p = results.map((r) => r.detail).join("\n");
    expect(p).toContain("idx_watchlists_secret_plain");
    expect(p).not.toMatch(/SCAN watchlists(?! USING)/);
  });
});
