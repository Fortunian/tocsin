import type { Env } from "../env";
import { encryptSecret, loadKek } from "../lib/secret-box";
import { getSettingInt } from "../lib/settings";

// Code fallback only. The live value is settings.webhooks.reencrypt_batch
// (migrations/0026_webhook_secret_enc.sql).
export const FALLBACK_REENCRYPT_BATCH = 500;

// idx_watchlists_secret_plain (partial: webhook_secret IS NOT NULL). A moved
// row leaves the index, so each run reads only rows still to move.
export const REENCRYPT_READ_SQL =
  "SELECT id, webhook_secret FROM watchlists WHERE webhook_secret IS NOT NULL AND webhook_secret_enc IS NULL ORDER BY id LIMIT ?";
// Guarded by the plaintext the read saw: a PATCH between the read and this
// write (a new secret) makes it change 0 rows, and the next run moves the new one.
export const REENCRYPT_WRITE_SQL =
  "UPDATE watchlists SET webhook_secret_enc = ?, webhook_secret = NULL WHERE id = ? AND webhook_secret = ? AND webhook_secret_enc IS NULL";

export interface ReencryptResult {
  read: number;
  moved: number;
  has_more: boolean;
}

// Moves webhook secrets written before WEBHOOK_KEK was set (or before TCS-82)
// to webhook_secret_enc and nulls the plaintext, at most
// webhooks.reencrypt_batch rows per run, in one transaction. Idempotent: a
// moved row is not read again. Without a usable KEK it moves nothing.
export async function reencryptWebhookSecrets(env: Env): Promise<ReencryptResult> {
  const res: ReencryptResult = { read: 0, moved: 0, has_more: false };
  const batch = await getSettingInt(env.DB, "webhooks.reencrypt_batch", FALLBACK_REENCRYPT_BATCH);
  if (batch < 1) {
    console.error(JSON.stringify({ lane: "reencrypt", err: `knob out of range: reencrypt_batch=${batch}` }));
    return res;
  }
  const { results } = await env.DB.prepare(REENCRYPT_READ_SQL).bind(batch).all<{ id: string; webhook_secret: string }>();
  res.read = results.length;
  if (results.length === 0) return res;
  const kek = await loadKek(env, "reencrypt");
  if (!kek) return res;

  const writes = await Promise.all(
    results.map(async (r) => env.DB.prepare(REENCRYPT_WRITE_SQL).bind(await encryptSecret(kek, r.id, r.webhook_secret), r.id, r.webhook_secret)),
  );
  const out = await env.DB.batch(writes);
  res.moved = out.reduce((n, o) => n + o.meta.changes, 0);
  res.has_more = results.length === batch;
  console.log(JSON.stringify({ lane: "reencrypt", ...res }));
  return res;
}
