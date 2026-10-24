-- TCS-94: DKIM signing of the mail seam (src/mail/dkim.ts). Additive only:
-- seed rows, no schema change. The private key is the wrangler secret
-- DKIM_PRIVATE_KEY, never a row.
-- Signing domain (d=) of the DKIM signature. Blank: mail goes out unsigned.
INSERT OR IGNORE INTO settings (key, value) VALUES ('mail.dkim_domain', 'tocsin.sh');
-- DKIM selector (s=); the public key is the TXT record mcdkim._domainkey.tocsin.sh. Blank: unsigned.
INSERT OR IGNORE INTO settings (key, value) VALUES ('mail.dkim_selector', 'mcdkim');
-- Warning channel of the mail seam, never an ingester: an unsigned send
-- overwrites its last_warning and last_run_at in place. enabled 0 keeps it off
-- the ingest cron, the status page and /v1/check coverage. Retention: docs/RETENTION.md.
INSERT OR IGNORE INTO sources (id, kind, enabled) VALUES ('mail', 'mail', 0);
