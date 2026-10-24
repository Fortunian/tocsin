-- TCS-82 item 8: a shorter DNS cache at send time. Additive only.
-- Seconds a DNS over HTTPS answer for a webhook host is cached in KV: 60 (the
-- KV minimum). 0 means no cache: the host is resolved at every send. Only the
-- shipped value (0023) changes, so an edited row keeps its value.
UPDATE settings SET value = '60' WHERE key = 'webhooks.dns_cache_seconds' AND value = '600';
