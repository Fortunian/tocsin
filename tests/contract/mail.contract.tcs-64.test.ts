// contract-test
import { describe, expect, it } from "vitest";
import { MailChannelsMailer, MailSendError } from "../../src/mail/send";

// Real-vendor contract suite for the MailChannels adapter (BH-7563 rule 4).
// Off the PR path: .github/workflows/mail-contract.yml runs it on main,
// nightly and on PRs that change src/mail/. Every call uses ?dry-run=true, so
// no mail leaves and nothing is spent. Without MAILCHANNELS_API_KEY each test
// skips. A 5xx or network error is a vendor failure: skip plus an alert line.
// The suite also refuses to run unless TOCSIN_CONTRACT=1, which only
// `npm run test:contract` (mail-contract.yml) sets: a MAILCHANNELS_API_KEY
// added to the CI test job can never make `npm test` call the vendor.

export const CONTRACT_ENABLED = process.env.TOCSIN_CONTRACT === "1";
const KEY = CONTRACT_ENABLED ? (process.env.MAILCHANNELS_API_KEY ?? "") : "";
const FROM = process.env.MAIL_CONTRACT_FROM ?? "keys@tocsin.sh";
const TO = process.env.MAIL_CONTRACT_TO ?? "contract-fixture@tocsin.sh";
const NO_KEY = "MAILCHANNELS_API_KEY not set";

type Skip = (note?: string) => never;

function vendorFailure(err: unknown, skip: Skip): never {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(JSON.stringify({ lane: "mail-contract", alert: "vendor_failure", err: detail }));
  return skip(`vendor failure: ${detail}`);
}

// Runs the send; a 5xx or a network error skips, every other error is returned.
async function attempt(m: MailChannelsMailer, msg: Parameters<MailChannelsMailer["send"]>[0], skip: Skip): Promise<unknown> {
  try {
    await m.send(msg);
    return null;
  } catch (err) {
    if (err instanceof MailSendError && err.status < 500) return err;
    return vendorFailure(err, skip);
  }
}

describe.skipIf(!CONTRACT_ENABLED)("MailChannels adapter against the real API (dry run)", () => {
  it("accepts a well-formed message (2xx)", async (ctx) => {
    if (!KEY) return ctx.skip(NO_KEY);
    const err = await attempt(new MailChannelsMailer(KEY, true), { to: TO, from: FROM, subject: "Tocsin contract test", text: "dry run" }, ctx.skip);
    expect(err).toBeNull();
  });

  it("answers a MailSendError with status 401 for a bad key", async (ctx) => {
    if (!KEY) return ctx.skip(NO_KEY);
    const err = await attempt(new MailChannelsMailer("key-fixture-invalid", true), { to: TO, from: FROM, subject: "s", text: "t" }, ctx.skip);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).status).toBe(401);
  });

  it("answers a MailSendError for an invalid recipient", async (ctx) => {
    if (!KEY) return ctx.skip(NO_KEY);
    const err = await attempt(new MailChannelsMailer(KEY, true), { to: "not-an-address", from: FROM, subject: "s", text: "t" }, ctx.skip);
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).status).toBeGreaterThanOrEqual(400);
  });
});
