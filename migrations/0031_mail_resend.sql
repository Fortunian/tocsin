-- TCS-97: the mail provider becomes Resend (src/mail/resend.ts). Data only,
-- no schema change. The guard keeps any value an operator set other than the
-- old seed. Resend signs the mail itself, so the DKIM rows of 0030 and the
-- secret DKIM_PRIVATE_KEY are read only when mail.provider = mailchannels.
-- To switch back: UPDATE settings SET value = 'mailchannels' WHERE key = 'mail.provider';
UPDATE settings SET value = 'resend' WHERE key = 'mail.provider' AND value = 'mailchannels';
