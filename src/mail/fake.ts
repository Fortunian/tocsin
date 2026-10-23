import type { MailMessage, Mailer } from "./send";
import { MailSendError } from "./send";

// Test fake of the mail seam: 0 network calls. Each message is appended to a
// KV outbox per recipient, so a test reads it whatever isolate served the
// request. A message from FAKE_FAIL_FROM fails like a provider 500.
export const FAKE_FAIL_FROM = "fail@fake.test";
const OUTBOX_TTL_SECONDS = 3600; // KV minimum is 60; a test outbox needs no more than an hour.

const outboxKey = (to: string) => `mail:fake:${to}`;

export class FakeMailer implements Mailer {
  constructor(private readonly kv: KVNamespace) {}

  async send(msg: MailMessage): Promise<void> {
    if (msg.from === FAKE_FAIL_FROM) throw new MailSendError(500, "fake failure");
    const box = await readFakeOutbox(this.kv, msg.to);
    box.push({ ...msg });
    await this.kv.put(outboxKey(msg.to), JSON.stringify(box), { expirationTtl: OUTBOX_TTL_SECONDS });
  }
}

export async function readFakeOutbox(kv: KVNamespace, to: string): Promise<MailMessage[]> {
  const raw = await kv.get(outboxKey(to));
  return raw === null ? [] : (JSON.parse(raw) as MailMessage[]);
}
