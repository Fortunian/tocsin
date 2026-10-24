import { afterEach, describe, expect, it, vi } from "vitest";
import { noteDkimUnsigned, resolveDkim } from "../../src/mail/dkim";
import { MailChannelsMailer, MailSendError } from "../../src/mail/send";

// TCS-94: the DKIM config of the mail seam. No network: fetch is mocked.

const KEY = `fixture-dkim-key-not-a-real-key-${crypto.randomUUID()}`;
const CFG = { domain: "tocsin.sh", selector: "mcdkim", privateKey: KEY };
const MSG = { to: "u@example.test", from: "keys@tocsin.sh", subject: "s", text: "t" };

afterEach(() => vi.restoreAllMocks());

describe("resolveDkim", () => {
  it("U1: a key and both rows resolve to signed", () => {
    expect(resolveDkim("AAAA", "tocsin.sh", "mcdkim")).toEqual({
      state: "signed",
      config: { domain: "tocsin.sh", selector: "mcdkim", privateKey: "AAAA" },
    });
  });

  it("U2: a PEM key with CRLF and armor lines resolves to its joined base64 body", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\r\nMIIEv\r\nQIBAD\r\nANBgk=\r\n-----END PRIVATE KEY-----\r\n";
    const r = resolveDkim(pem, "tocsin.sh", "mcdkim");
    expect(r.state).toBe("signed");
    expect(r.state === "signed" && r.config.privateKey).toBe("MIIEvQIBADANBgk=");
  });

  it("U3: a base64 key with a trailing newline is trimmed", () => {
    const r = resolveDkim("QUJD\n", "tocsin.sh", "mcdkim");
    expect(r.state === "signed" && r.config.privateKey).toBe("QUJD");
  });

  it("U4: no key, a blank key or an armor-only PEM resolves to off, with DKIM_PRIVATE_KEY missing", () => {
    for (const secret of [undefined, "", "   ", "\n", "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n"]) {
      const r = resolveDkim(secret, "tocsin.sh", "mcdkim");
      expect(r.state, JSON.stringify(secret)).toBe("off");
      expect(r.state !== "signed" && r.missing).toEqual(["DKIM_PRIVATE_KEY"]);
    }
  });

  it("U5: a key with a blank row resolves to incomplete and names the blank rows", () => {
    const blankDomain = resolveDkim("AAAA", "", "mcdkim");
    expect(blankDomain).toEqual({ state: "incomplete", missing: ["mail.dkim_domain"] });
    expect(resolveDkim("AAAA", "tocsin.sh", "  ")).toEqual({ state: "incomplete", missing: ["mail.dkim_selector"] });
    expect(resolveDkim("AAAA", "", "")).toEqual({ state: "incomplete", missing: ["mail.dkim_domain", "mail.dkim_selector"] });
  });
});

describe("noteDkimUnsigned", () => {
  it("U6: a failed UPDATE is logged as one mail-lane error and never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = {
      prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("D1 down")) }) }),
    } as unknown as D1Database;
    await expect(noteDkimUnsigned(db, ["DKIM_PRIVATE_KEY"], "2026-10-24T00:00:00.000Z")).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(err.mock.calls[0][0])) as { lane: string; err: string };
    expect(line.lane).toBe("mail");
    expect(line.err).toContain("D1 down");
  });
});

describe("MailChannelsMailer body", () => {
  function mockFetch(res: Response) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
  }
  function sentBody(f: ReturnType<typeof mockFetch>): { personalizations: Record<string, unknown>[] } {
    expect(f).toHaveBeenCalledTimes(1);
    return JSON.parse(String((f.mock.calls[0][1] as RequestInit).body)) as { personalizations: Record<string, unknown>[] };
  }

  it("U7: body with a DKIM config carries the three dkim fields in personalizations[0]", async () => {
    const f = mockFetch(new Response("", { status: 202 }));
    await new MailChannelsMailer("k", false, CFG).send(MSG);
    const p = sentBody(f).personalizations[0];
    expect(p.dkim_domain).toBe("tocsin.sh");
    expect(p.dkim_selector).toBe("mcdkim");
    expect(p.dkim_private_key).toBe(KEY);
    expect(p.to).toEqual([{ email: MSG.to }]);
  });

  it("U8: body without a DKIM config carries no dkim_ field", async () => {
    const f = mockFetch(new Response("", { status: 202 }));
    await new MailChannelsMailer("k").send(MSG);
    const body = sentBody(f);
    expect(JSON.stringify(body)).not.toContain("dkim_");
    expect(body.personalizations[0]).toEqual({ to: [{ email: MSG.to }] });
  });

  it("U9: a provider failure throws MailSendError whose message holds no key", async () => {
    mockFetch(new Response("bad", { status: 500 }));
    const p = new MailChannelsMailer("k", false, CFG).send(MSG);
    await expect(p).rejects.toBeInstanceOf(MailSendError);
    await expect(p).rejects.toSatisfy((e: Error) => !e.message.includes(KEY) && e.message.includes("500"));
  });
});
