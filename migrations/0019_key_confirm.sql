-- TCS-64: API keys prove email ownership with a one-time link. Settings rows
-- only, additive. INSERT OR IGNORE keeps a re-run safe and never overwrites an
-- edited value. Code fallbacks: src/routes/keys.ts FALLBACK_* constants.

-- Seconds a confirm link stays valid (KV TTL of keyconfirm:v1:<hash>).
INSERT OR IGNORE INTO settings (key, value) VALUES ('keys.confirm_ttl_seconds', '3600');
-- Confirm-link mails per client IP per clock hour (POST /v1/keys and /v1/keys/rotate).
INSERT OR IGNORE INTO settings (key, value) VALUES ('keys.ip_sends_per_hour', '10');
-- Confirm-link mails per email address per clock hour.
INSERT OR IGNORE INTO settings (key, value) VALUES ('keys.email_sends_per_hour', '3');
-- Mails sent per UTC day, all addresses. At the cap the send answers 503 and logs an alert line.
INSERT OR IGNORE INTO settings (key, value) VALUES ('mail.daily_send_cap', '500');
-- Mail provider of src/mail/send.ts. Known: mailchannels.
INSERT OR IGNORE INTO settings (key, value) VALUES ('mail.provider', 'mailchannels');
-- Sender address of every mail.
INSERT OR IGNORE INTO settings (key, value) VALUES ('mail.from_address', 'keys@tocsin.sh');
-- Base URL of the confirm link. Never taken from the request Host header.
INSERT OR IGNORE INTO settings (key, value) VALUES ('keys.confirm_base_url', 'https://tocsin.sh');
