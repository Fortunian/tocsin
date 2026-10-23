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
  // MailChannels Email API key (wrangler secret). Unset: POST /v1/keys answers 503.
  MAILCHANNELS_API_KEY?: string;
  // "fake" selects the test mailer (src/mail/fake.ts). Set only in vitest.config.ts, never in wrangler.toml.
  MAIL_TRANSPORT?: string;
}
