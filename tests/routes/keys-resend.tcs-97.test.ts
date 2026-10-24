import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { readFakeOutbox } from "../../src/mail/fake";
import { nextIp, uniqueEmail } from "./keys-helpers.tcs-8";

// TCS-97: POST /v1/keys with the settings row mail.provider = resend. Resend
// signs the mail itself, so the route sends no DKIM fields, writes no unsigned
// warning, and answers Tocsin-Mail-Dkim: provider. Drives the worker's default
// export; the fake mailer (MAIL_TRANSPORT=fake) records what would be sent.

const FIXTURE = `fixture-dkim-key-not-a-real-key-${crypto.randomUUID()}`;
const TOKEN_RE = /token=(tct_[0-9a-f]{64})/;

async function setProvider(value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('mail.provider', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(value)
    .run();
}

async function send(path: string, body: unknown, over: Partial<typeof env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://tocsin.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
      body: JSON.stringify(body),
    }),
    { ...env, ...over } as typeof env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const mailRow = () => env.DB.prepare("SELECT last_warning, last_run_at FROM sources WHERE id = 'mail'").first<{ last_warning: string | null; last_run_at: string | null }>();

beforeEach(() => setProvider("resend"));
afterEach(() => vi.restoreAllMocks());
afterAll(() => setProvider("resend"));

describe("POST /v1/keys with mail.provider = resend", () => {
  it("R1: 202, Tocsin-Mail-Dkim provider, one mail in the outbox", async () => {
    const email = uniqueEmail("resend");
    const res = await send("/v1/keys", { email });
    expect(res.status, await res.clone().text()).toBe(202);
    expect(res.headers.get("Tocsin-Mail-Dkim")).toBe("provider");
    expect(await res.json()).toMatchObject({ status: "sent" });
    expect(await readFakeOutbox(env.CURSORS, email)).toHaveLength(1);
  });

  it("R2: with DKIM_PRIVATE_KEY set, the mail carries no dkim field and the key reaches no log line", async () => {
    const lines: string[] = [];
    const keep = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(keep);
    vi.spyOn(console, "error").mockImplementation(keep);
    vi.spyOn(console, "warn").mockImplementation(keep);
    const email = uniqueEmail("resend-dkim");
    const res = await send("/v1/keys", { email }, { DKIM_PRIVATE_KEY: FIXTURE });
    expect(res.status).toBe(202);
    expect(res.headers.get("Tocsin-Mail-Dkim")).toBe("provider");
    const box = await readFakeOutbox(env.CURSORS, email);
    expect(box).toHaveLength(1);
    expect(Object.keys(box[0]).filter((k) => k.startsWith("dkim_"))).toEqual([]);
    expect(JSON.stringify(box[0])).not.toContain(FIXTURE);
    expect(lines.join("\n")).not.toContain(FIXTURE);
  });

  it("R3: no unsigned warning: the mail row and the warn log stay untouched", async () => {
    await env.DB.prepare("UPDATE sources SET last_warning = NULL, last_run_at = NULL WHERE id = 'mail'").run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await send("/v1/keys", { email: uniqueEmail("resend-warn") })).status).toBe(202);
    expect((await send("/v1/keys", { email: uniqueEmail("resend-warn-k") }, { DKIM_PRIVATE_KEY: FIXTURE })).status).toBe(202);
    expect(await mailRow()).toEqual({ last_warning: null, last_run_at: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it("R4: create + confirm with provider resend makes 0 fetch calls", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const email = uniqueEmail("resend-budget");
    expect((await send("/v1/keys", { email }, { RESEND_API_KEY: "key-fixture-resend" })).status).toBe(202);
    const mails = await readFakeOutbox(env.CURSORS, email);
    const token = TOKEN_RE.exec(mails[0].text)![1];
    const ok = await send("/v1/keys/confirm", { token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ email });
    expect(spy).not.toHaveBeenCalled();
  });

  it("R5: the same route with mail.provider = mailchannels still follows the DKIM path (off, then signed)", async () => {
    await setProvider("mailchannels");
    const off = await send("/v1/keys", { email: uniqueEmail("mc-off") });
    expect(off.status).toBe(202);
    expect(off.headers.get("Tocsin-Mail-Dkim")).toBe("off");
    const email = uniqueEmail("mc-signed");
    const signed = await send("/v1/keys", { email }, { DKIM_PRIVATE_KEY: FIXTURE });
    expect(signed.headers.get("Tocsin-Mail-Dkim")).toBe("signed");
    expect((await readFakeOutbox(env.CURSORS, email))[0].dkim_private_key).toBe(FIXTURE);
  });
});
