import type { Env } from "../env";
import { FakeMailer } from "./fake";

// The one mail seam (CLAUDE.md iron law, BH-7563). Every outbound mail goes
// through getMailer(); this is the only file that builds a MailChannels URL.

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
export class MailChannelsMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly dryRun = false) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch(this.dryRun ? `${MAILCHANNELS_SEND_URL}?dry-run=true` : MAILCHANNELS_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: msg.from },
        subject: msg.subject,
        content: [{ type: "text/plain", value: msg.text }],
      }),
    });
    if (!res.ok) throw new MailSendError(res.status, (await res.text().catch(() => "")).slice(0, 200));
  }
}

const PROVIDERS = new Set(["mailchannels"]);

// provider is the settings row mail.provider. An unknown provider, or a known
// one with no credential, answers null: the caller refuses to send. The fake
// is answered only when MAIL_TRANSPORT=fake, which only vitest.config.ts sets.
export function getMailer(
  env: Pick<Env, "CURSORS" | "MAIL_TRANSPORT" | "MAILCHANNELS_API_KEY">,
  provider: string,
): Mailer | null {
  if (!PROVIDERS.has(provider)) return null;
  if (env.MAIL_TRANSPORT === "fake") return new FakeMailer(env.CURSORS);
  if (provider === "mailchannels" && env.MAILCHANNELS_API_KEY) return new MailChannelsMailer(env.MAILCHANNELS_API_KEY);
  return null;
}
