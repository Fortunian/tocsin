import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeMailer, readFakeOutbox } from "../../src/mail/fake";
import { ResendMailer } from "../../src/mail/resend";
import { MailChannelsMailer, MailSendError, getMailer, providerSignsDkim } from "../../src/mail/send";

// TCS-97: the Resend adapter of the mail seam and the provider switch.
// No network: fetch is stubbed.

const KEY = "key-fixture-1";
const CFG = { domain: "tocsin.sh", selector: "mcdkim", privateKey: "fixture-dkim-key-not-a-real-key" };
const MSG = { to: "u@example.test", from: "keys@tocsin.sh", subject: "Your Tocsin API key link", text: "open the link" };

function stubFetch(...answers: Response[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seen.push({ url: String(input), init: init ?? {} });
    return answers.shift()!;
  });
  return { seen, spy };
}

afterEach(() => vi.restoreAllMocks());

describe("ResendMailer", () => {
  it("M1: posts once to the Resend emails API with the bearer key and the documented JSON body", async () => {
    const { seen, spy } = stubFetch(new Response(JSON.stringify({ id: "fixture-id" }), { status: 200 }));
    await new ResendMailer(KEY).send(MSG);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen[0].url).toBe("https://api.resend.com/emails");
    expect(seen[0].init.method).toBe("POST");
    const h = new Headers(seen[0].init.headers);
    expect(h.get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(h.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ from: MSG.from, to: [MSG.to], subject: MSG.subject, text: MSG.text });
  });

  it("M2: a 422 JSON answer throws MailSendError with the status and the body's message", async () => {
    stubFetch(new Response(JSON.stringify({ statusCode: 422, message: "Invalid `to` field.", name: "validation_error" }), { status: 422 }));
    const err = await new ResendMailer(KEY).send(MSG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).status).toBe(422);
    expect((err as MailSendError).message).toContain("Invalid `to` field.");
    expect((err as MailSendError).message).not.toContain("validation_error");
  });

  it("M3: a 500 with a non-JSON body throws MailSendError with the raw text", async () => {
    stubFetch(new Response("oops", { status: 500 }));
    const err = await new ResendMailer(KEY).send(MSG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).status).toBe(500);
    expect((err as MailSendError).message).toContain("oops");
  });

  it("M4: the thrown message never holds the key, with an empty body or a body that echoes it", async () => {
    stubFetch(new Response("", { status: 401 }), new Response(JSON.stringify({ message: "bad key" }), { status: 403 }));
    const m = new ResendMailer(KEY);
    const e1 = (await m.send(MSG).catch((e: unknown) => e)) as MailSendError;
    expect(e1).toBeInstanceOf(MailSendError);
    expect(e1.status).toBe(401);
    expect(e1.message).not.toContain(KEY);
    const e2 = (await m.send(MSG).catch((e: unknown) => e)) as MailSendError;
    expect(e2.status).toBe(403);
    expect(e2.message).toContain("bad key");
    expect(e2.message).not.toContain(KEY);
  });
});

describe("provider switch", () => {
  it("M5: MAIL_TRANSPORT=fake answers the fake for resend, and its outbox entry has no dkim field even with a DKIM config", async () => {
    expect(env.MAIL_TRANSPORT).toBe("fake");
    const m = getMailer({ ...env, RESEND_API_KEY: KEY }, "resend", CFG);
    expect(m).toBeInstanceOf(FakeMailer);
    const to = `m5-${crypto.randomUUID()}@example.test`;
    await m!.send({ ...MSG, to });
    const box = await readFakeOutbox(env.CURSORS, to);
    expect(box).toHaveLength(1);
    expect(Object.keys(box[0]).filter((k) => k.startsWith("dkim_"))).toEqual([]);
    // The MailChannels fake still carries the fields.
    const to2 = `m5mc-${crypto.randomUUID()}@example.test`;
    await getMailer(env, "mailchannels", CFG)!.send({ ...MSG, to: to2 });
    expect((await readFakeOutbox(env.CURSORS, to2))[0].dkim_selector).toBe("mcdkim");
  });

  it("M6: with MAIL_TRANSPORT unset the row picks the adapter; no key, wrong case or unknown answers null", () => {
    const prod = { ...env, MAIL_TRANSPORT: undefined, MAILCHANNELS_API_KEY: undefined, RESEND_API_KEY: undefined };
    expect(getMailer({ ...prod, RESEND_API_KEY: KEY }, "resend")).toBeInstanceOf(ResendMailer);
    expect(getMailer({ ...prod, RESEND_API_KEY: KEY }, "resend", CFG)).toBeInstanceOf(ResendMailer);
    expect(getMailer(prod, "resend")).toBeNull();
    expect(getMailer({ ...prod, MAILCHANNELS_API_KEY: KEY }, "resend")).toBeNull();
    expect(getMailer({ ...prod, MAILCHANNELS_API_KEY: KEY }, "mailchannels")).toBeInstanceOf(MailChannelsMailer);
    expect(getMailer({ ...prod, RESEND_API_KEY: KEY }, "mailchannels")).toBeNull();
    expect(getMailer({ ...prod, RESEND_API_KEY: KEY }, "Resend")).toBeNull();
    expect(getMailer({ ...prod, RESEND_API_KEY: KEY }, "nope")).toBeNull();
    expect(providerSignsDkim("resend")).toBe(true);
    for (const p of ["mailchannels", "nope", "Resend", "", " resend"]) expect(providerSignsDkim(p)).toBe(false);
  });
});
