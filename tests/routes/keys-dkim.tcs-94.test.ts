import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { runIngesters } from "../../src/ingest/registry";
import { MAIL_WARNING_SQL } from "../../src/mail/dkim";
import { readFakeOutbox } from "../../src/mail/fake";
import { STATUS_SOURCES_SQL } from "../../src/site/data";
import { nextIp, uniqueEmail } from "./keys-helpers.tcs-8";

// TCS-94: POST /v1/keys signs the mail with DKIM when the worker secret
// DKIM_PRIVATE_KEY and the settings rows mail.dkim_domain and
// mail.dkim_selector are set. Drives the worker's default export with an env
// override; the fake mailer (MAIL_TRANSPORT=fake) records the dkim fields.

const FIXTURE = `fixture-dkim-key-not-a-real-key-${crypto.randomUUID()}`;
const UNSIGNED_OFF = "mail sent unsigned (no DKIM): not set: DKIM_PRIVATE_KEY";

async function postKeys(email: string, secret?: string): Promise<Response> {
  const e = secret === undefined ? env : ({ ...env, DKIM_PRIVATE_KEY: secret } as typeof env);
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://tocsin.test/v1/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
      body: JSON.stringify({ email }),
    }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const mailWarning = () => env.DB.prepare("SELECT last_warning, last_run_at, enabled FROM sources WHERE id = 'mail'").first<{ last_warning: string | null; last_run_at: string | null; enabled: number }>();

const setProvider = (value: string) => env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'mail.provider'").bind(value).run();

// The DKIM path is the MailChannels one; migration 0031 (TCS-97) seeds mail.provider = resend.
beforeEach(() => setProvider("mailchannels"));
afterEach(() => vi.restoreAllMocks());
afterAll(() => setProvider("resend"));

describe("POST /v1/keys with DKIM", () => {
  it("R1: secret set and seeded rows: 202, Tocsin-Mail-Dkim signed, the outbox entry carries the three dkim fields", async () => {
    const email = uniqueEmail("dkim-signed");
    const res = await postKeys(email, FIXTURE);
    expect(res.status, await res.clone().text()).toBe(202);
    expect(res.headers.get("Tocsin-Mail-Dkim")).toBe("signed");
    expect(await res.json()).toMatchObject({ status: "sent" });
    const box = await readFakeOutbox(env.CURSORS, email);
    expect(box).toHaveLength(1);
    expect(box[0].dkim_domain).toBe("tocsin.sh");
    expect(box[0].dkim_selector).toBe("mcdkim");
    expect(box[0].dkim_private_key).toBe(FIXTURE);
  });

  it("R2: no secret: 202, Tocsin-Mail-Dkim off, no dkim field in the outbox, and the mail row holds the warning", async () => {
    const email = uniqueEmail("dkim-off");
    const before = Date.now();
    const res = await postKeys(email);
    expect(res.status).toBe(202);
    expect(res.headers.get("Tocsin-Mail-Dkim")).toBe("off");
    const box = await readFakeOutbox(env.CURSORS, email);
    expect(box).toHaveLength(1);
    expect(Object.keys(box[0]).filter((k) => k.startsWith("dkim_"))).toEqual([]);
    const row = await mailWarning();
    expect(row?.last_warning).toBe(UNSIGNED_OFF);
    expect(Date.parse(row?.last_run_at ?? "")).toBeGreaterThanOrEqual(before - 1000);
  });

  it("R3: the private key never reaches a log line; the unsigned warn line names the missing secret only", async () => {
    const lines: string[] = [];
    const keep = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(keep);
    vi.spyOn(console, "error").mockImplementation(keep);
    const warn = vi.spyOn(console, "warn").mockImplementation(keep);

    expect((await postKeys(uniqueEmail("dkim-log"), FIXTURE)).status).toBe(202);
    expect(warn).not.toHaveBeenCalled();

    expect((await postKeys(uniqueEmail("dkim-log-off"))).status).toBe(202);
    expect(warn).toHaveBeenCalledTimes(1);
    const w = JSON.parse(String(warn.mock.calls[0][0])) as { lane: string; warn: string; missing: string[] };
    expect(w).toEqual({ lane: "mail", warn: "dkim_unsigned", missing: ["DKIM_PRIVATE_KEY"] });
    expect(lines.join("\n")).not.toContain(FIXTURE);
  });

  it("R4: the mail row is enabled 0: no ingest outcome and no status-page row", async () => {
    const row = await mailWarning();
    expect(row?.enabled).toBe(0);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const outcomes = await runIngesters(env, {}, () => new Date());
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.map((o) => o.source)).not.toContain("mail");
    const { results } = await env.DB.prepare(STATUS_SOURCES_SQL).all<{ id: string }>();
    expect(results.map((r) => r.id)).not.toContain("mail");
  });
});

describe("migration 0030_mail_dkim", () => {
  it("R5: seeds mail.dkim_domain and mail.dkim_selector, a re-run keeps an edited value, and the warning UPDATE is a PK search", async () => {
    const get = (k: string) => env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(k).first<{ value: string }>();
    expect((await get("mail.dkim_domain"))?.value).toBe("tocsin.sh");
    expect((await get("mail.dkim_selector"))?.value).toBe("mcdkim");

    const mig = env.TEST_MIGRATIONS.find((m) => m.name === "0030_mail_dkim.sql");
    expect(mig).toBeDefined();
    const count = async () =>
      (await env.DB.prepare("SELECT (SELECT COUNT(*) FROM settings) + (SELECT COUNT(*) FROM sources) AS n").first<{ n: number }>())?.n;
    const n0 = await count();
    try {
      await env.DB.prepare("UPDATE settings SET value = 'x' WHERE key = 'mail.dkim_selector'").run();
      for (const q of mig!.queries) await env.DB.prepare(q).run();
      expect(await count()).toBe(n0);
      expect((await get("mail.dkim_selector"))?.value).toBe("x");
    } finally {
      await env.DB.prepare("UPDATE settings SET value = 'mcdkim' WHERE key = 'mail.dkim_selector'").run();
    }

    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${MAIL_WARNING_SQL}`).bind("w", "t").all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toMatch(/SEARCH sources USING (COVERING )?INDEX \S+ \(id=\?\)/);
    expect(plan).not.toMatch(/SCAN sources/);
  });
});
