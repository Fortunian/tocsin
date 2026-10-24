import type { Env } from "../env";
import type { DkimConfig } from "./dkim";
import { FakeMailer } from "./fake";
import { ResendMailer } from "./resend";

// The one mail seam (CLAUDE.md iron law, BH-7563). Every outbound mail goes
// through getMailer(); this file and src/mail/resend.ts are the only files
// that build a vendor URL.

export interface MailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
}

export interface Mailer {
  // Resolves when the provider accepted the message; throws otherwise.
  send(msg: MailMessage): Promise<void>;
}

export class MailSendError extends Error {
  constructor(readonly status: number, detail = "") {
    super(`mail provider answered ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "MailSendError";
  }
}

const MAILCHANNELS_SEND_URL = "https://api.mailchannels.net/tx/v1/send";

// MailChannels Email API. dryRun asks the provider to check and render the
// message without sending it (the contract suite uses it: no mail, no spend).
// dkim (TCS-94): the provider signs the mail with it. The key goes in the
// request body only, never in a log line or an error message.
export class MailChannelsMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly dryRun = false,
    private readonly dkim: DkimConfig | null = null,
  ) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch(this.dryRun ? `${MAILCHANNELS_SEND_URL}?dry-run=true` : MAILCHANNELS_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }], ...dkimFields(this.dkim) }],
        from: { email: msg.from },
        subject: msg.subject,
        content: [{ type: "text/plain", value: msg.text }],
      }),
    });
    if (!res.ok) throw new MailSendError(res.status, (await res.text().catch(() => "")).slice(0, 200));
  }
}

// The per-personalization DKIM fields of the MailChannels send body; none without a config.
export function dkimFields(dkim: DkimConfig | null): Partial<Record<"dkim_domain" | "dkim_selector" | "dkim_private_key", string>> {
  return dkim ? { dkim_domain: dkim.domain, dkim_selector: dkim.selector, dkim_private_key: dkim.privateKey } : {};
}

const PROVIDERS = new Set(["mailchannels", "resend"]);
// Providers that sign the mail with their own DKIM key: the seam sends them no dkim fields.
const PROVIDER_SIGNS = new Set(["resend"]);

export function providerSignsDkim(provider: string): boolean {
  return PROVIDER_SIGNS.has(provider);
}

// provider is the settings row mail.provider. dkim (src/mail/dkim.ts) signs the mail when set; a provider that
// signs itself (providerSignsDkim) ignores it. An unknown provider, or a known
// one with no credential, answers null: the caller refuses to send. The fake
// is answered only when MAIL_TRANSPORT=fake, which only vitest.config.ts sets.
export function getMailer(
  env: Pick<Env, "CURSORS" | "MAIL_TRANSPORT" | "MAILCHANNELS_API_KEY" | "RESEND_API_KEY">,
  provider: string,
  dkim: DkimConfig | null = null,
): Mailer | null {
  if (!PROVIDERS.has(provider)) return null;
  if (env.MAIL_TRANSPORT === "fake") return new FakeMailer(env.CURSORS, providerSignsDkim(provider) ? null : dkim);
  if (provider === "resend" && env.RESEND_API_KEY) return new ResendMailer(env.RESEND_API_KEY);
  if (provider === "mailchannels" && env.MAILCHANNELS_API_KEY) return new MailChannelsMailer(env.MAILCHANNELS_API_KEY, false, dkim);
  return null;
}
