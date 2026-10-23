-- TCS-82 item 2: webhook secrets encrypted at rest. Additive only.
-- Retention: docs/RETENTION.md (the column lives and dies with its row).

-- "v1:<base64 iv>:<base64 ciphertext>": AES-256-GCM with the Worker secret
-- WEBHOOK_KEK, a random 12-byte IV per write, the watch list id as AAD. When
-- it is set, webhook_secret is NULL. webhook_secret stays (additive only) for
-- rows written without a KEK; the re-encrypt cron job moves them.
ALTER TABLE watchlists ADD COLUMN webhook_secret_enc TEXT;

-- The re-encrypt read: WHERE webhook_secret IS NOT NULL AND webhook_secret_enc IS NULL ORDER BY id LIMIT ?.
-- Partial, so it holds only the rows still to move (0 after the move).
CREATE INDEX IF NOT EXISTS idx_watchlists_secret_plain ON watchlists (id) WHERE webhook_secret IS NOT NULL;

-- Most plaintext webhook secrets the re-encrypt job moves per */10 cron run.
INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks.reencrypt_batch', '500');
