import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeMailer, readFakeOutbox } from "../../src/mail/fake";
import { MailChannelsMailer, MailSendError, getMailer } from "../../src/mail/send";
import { call, uniqueEmail } from "./keys-helpers.tcs-8";

// TCS-64 budget: the PR suite makes 0 vendor calls. The api project binds
// MAIL_TRANSPORT=fake (vitest.config.ts), so the mail seam answers the fake.

const TOKEN_RE = /token=(tct_[0-9a-f]{64})/;

async function openLastLink(email: string): Promise<Response> {
  const mails = await readFakeOutbox(env.CURSORS, email);
  const token = TOKEN_RE.exec(mails[mails.length - 1].text)![1];
  return call("GET", `/v1/keys/confirm?token=${token}`);
}

afterEach(() => vi.restoreAllMocks());

describe("mail seam budget", () => {
  it("a full create + confirm + rotate + confirm flow makes 0 fetch calls", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const email = uniqueEmail("budget");
    expect((await call("POST", "/v1/keys", { body: { email } })).status).toBe(202);
    expect((await openLastLink(email)).status).toBe(200);
    expect((await call("POST", "/v1/keys/rotate", { body: { email } })).status).toBe(202);
    expect((await openLastLink(email)).status).toBe(200);
    expect(await readFakeOutbox(env.CURSORS, email)).toHaveLength(2);
    expect(spy.mock.calls.filter((c) => String(c[0] instanceof Request ? c[0].url : c[0]).includes("api.mailchannels.net"))).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("getMailer answers the fake in the test env, even with a MailChannels key bound", () => {
    expect(env.MAIL_TRANSPORT).toBe("fake");
    expect(getMailer(env, "mailchannels")).toBeInstanceOf(FakeMailer);
    expect(getMailer({ ...env, MAILCHANNELS_API_KEY: "key-fixture-1" }, "mailchannels")).toBeInstanceOf(FakeMailer);
    expect(getMailer(env, "nope")).toBeNull();
  });

  it("with MAIL_TRANSPORT unset: no key answers null (fail closed), a key answers the MailChannels adapter", () => {
    const prod = { ...env, MAIL_TRANSPORT: undefined, MAILCHANNELS_API_KEY: undefined };
    expect(getMailer(prod, "mailchannels")).toBeNull();
    expect(getMailer({ ...prod, MAILCHANNELS_API_KEY: "key-fixture-1" }, "mailchannels")).toBeInstanceOf(MailChannelsMailer);
    expect(getMailer({ ...prod, MAILCHANNELS_API_KEY: "key-fixture-1" }, "nope")).toBeNull();
  });

  it("the MailChannels adapter posts one JSON message with X-Api-Key, and a non-2xx is a MailSendError (stubbed fetch, no network)", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const answers = [new Response("", { status: 202 }), new Response("bad", { status: 401 })];
    const stub = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return answers.shift()!;
    });
    const m = new MailChannelsMailer("key-fixture-1");
    const msg = { to: "to@example.test", from: "keys@tocsin.sh", subject: "s", text: "t" };
    await m.send(msg);
    expect(seen[0].url).toBe("https://api.mailchannels.net/tx/v1/send");
    expect(seen[0].init.method).toBe("POST");
    expect(new Headers(seen[0].init.headers).get("X-Api-Key")).toBe("key-fixture-1");
    const body = JSON.parse(String(seen[0].init.body));
    expect(body.personalizations).toEqual([{ to: [{ email: "to@example.test" }] }]);
    expect(body.from).toEqual({ email: "keys@tocsin.sh" });
    expect(body.subject).toBe("s");
    expect(body.content).toEqual([{ type: "text/plain", value: "t" }]);

    const err = await m.send(msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).status).toBe(401);
    expect(stub).toHaveBeenCalledTimes(2);
  });
});
