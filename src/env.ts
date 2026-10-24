export interface Env {
  DB: D1Database;
  CURSORS: KVNamespace;
  DELIVERIES: Queue;
  // Optional. Raises the GitHub API limit for the php-runtime, python-runtime,
  // deno-runtime and bun-runtime ingesters.
  GITHUB_TOKEN?: string;
  // NVD API key (wrangler secret). Unset: the NVD ingester runs at the keyless limit.
  NVD_API_KEY?: string;
  // Bearer token of POST /v1/internal/import (wrangler secret). Unset: the route answers 403.
  IMPORT_TOKEN?: string;
  // MailChannels Email API key (wrangler secret). Read only when mail.provider = mailchannels. Unset: POST /v1/keys answers 503.
  MAILCHANNELS_API_KEY?: string;
  // Resend API key (wrangler secret, TCS-97): a sending-only key restricted to tocsin.sh.
  // Read only when mail.provider = resend. Unset: POST /v1/keys answers 503.
  RESEND_API_KEY?: string;
  // DKIM private key of the sending domain (wrangler secret, TCS-94): base64 DER
  // or PEM of an RSA key. Read only when mail.provider = mailchannels (Resend signs
  // itself). Unset: mail goes out unsigned and src/mail/dkim.ts writes a warning
  // on the sources row 'mail'.
  DKIM_PRIVATE_KEY?: string;
  // AES-256 key for webhook secrets at rest, 32 bytes as base64 (wrangler
  // secret, src/lib/secret-box.ts). Unset: new webhook secrets are stored as
  // plaintext and each use logs kek_missing.
  WEBHOOK_KEK?: string;
  // "fake" selects the test mailer (src/mail/fake.ts). Set only in vitest.config.ts, never in wrangler.toml.
  MAIL_TRANSPORT?: string;
}
