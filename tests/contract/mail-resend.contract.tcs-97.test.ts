// contract-test
import { describe, expect, it } from "vitest";
import { ResendMailer } from "../../src/mail/resend";
import { MailSendError } from "../../src/mail/send";

// Real-vendor contract suite for the Resend adapter (BH-7563 rule 4, TCS-97).
// Off the PR path: .github/workflows/mail-contract.yml runs it on main,
// nightly and on PRs that change src/mail/. It refuses to run unless
// TOCSIN_CONTRACT=1 (only `npm run test:contract` sets it), and each test
// skips without RESEND_API_KEY. A 5xx or network error is a vendor failure:
// skip plus an alert line. Resend has no dry run: the bad-key and
// bad-recipient tests send nothing, but the accept test sends one real mail
// per run to Resend's test inbox delivered@resend.dev. That counts against
// the 3,000 mails a month of the free plan (about 30 to 60 a month at main
// plus nightly).

export const CONTRACT_ENABLED = process.env.TOCSIN_CONTRACT === "1";
const KEY = CONTRACT_ENABLED ? (process.env.RESEND_API_KEY ?? "") : "";
const FROM = process.env.MAIL_CONTRACT_FROM ?? "keys@tocsin.sh";
const TO = "delivered@resend.dev";
const NO_KEY = "RESEND_API_KEY not set";

type Skip = (note?: string) => never;

function vendorFailure(err: unknown, skip: Skip): never {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(JSON.stringify({ lane: "mail-contract", alert: "vendor_failure", vendor: "resend", err: detail }));
  return skip(`vendor failure: ${detail}`);
}

// Runs the send; a 5xx or a network error skips, every other error is returned.
async function attempt(m: ResendMailer, msg: Parameters<ResendMailer["send"]>[0], skip: Skip): Promise<unknown> {
  try {
    await m.send(msg);
    return null;
  } catch (err) {
    if (err instanceof MailSendError && err.status < 500) return err;
    return vendorFailure(err, skip);
  }
}

describe.skipIf(!CONTRACT_ENABLED)("Resend adapter against the real API", () => {
  it("answers a MailSendError with status 401 or 403 for a bad key (no send)", async (ctx) => {
    if (!KEY) return ctx.skip(NO_KEY);
    const err = await attempt(new ResendMailer("key-fixture-invalid"), { to: TO, from: FROM, subject: "s", text: "t" }, ctx.skip);
    expect(err).toBeInstanceOf(MailSendError);
    expect([401, 403]).toContain((err as MailSendError).status);
  });

  it("answers a MailSendError 4xx for an invalid recipient (no send)", async (ctx) => {
    if (!KEY) return ctx.skip(NO_KEY);
    const err = await attempt(new ResendMailer(KEY), { to: "not-an-address", from: FROM, subject: "s", text: "t" }, ctx.skip);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).status).toBeGreaterThanOrEqual(400);
    expect((err as MailSendError).status).toBeLessThan(500);
  });

  it("accepts a well-formed message to the Resend test inbox (2xx, one real send)", async (ctx) => {
    if (!KEY) return ctx.skip(NO_KEY);
    const err = await attempt(new ResendMailer(KEY), { to: TO, from: FROM, subject: "Tocsin contract test", text: "contract test" }, ctx.skip);
    expect(err).toBeNull();
  });
});
