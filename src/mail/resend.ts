import type { MailMessage, Mailer } from "./send";
import { MailSendError } from "./send";

// Resend Email API (TCS-97). A vendor protocol constant, not a knob.
const RESEND_SEND_URL = "https://api.resend.com/emails";

// Resend signs the mail with the DKIM key of the verified domain, so this
// adapter takes no DKIM config. Resend has no dry run: the PR suite uses the
// fake (src/mail/fake.ts). The key goes in the Authorization header only,
// never in a log line or an error message.
export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch(RESEND_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) throw new MailSendError(res.status, errorDetail(await res.text().catch(() => "")).slice(0, 200));
  }
}

// Resend answers an error as JSON with a `message` field; any other body is kept as text.
function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const message = parsed !== null && typeof parsed === "object" ? (parsed as { message?: unknown }).message : undefined;
    if (typeof message === "string") return message;
  } catch {
    // not JSON
  }
  return body;
}
