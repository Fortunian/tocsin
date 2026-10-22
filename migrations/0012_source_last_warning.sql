-- TCS-50: a warnings channel per source. runIngesters writes RunResult.warnings
-- here without marking the source failed (src/ingest/registry.ts).
-- Retention: one value per sources row, overwritten in place by the next run
-- that has a warning (docs/RETENTION.md). Additive only.
ALTER TABLE sources ADD COLUMN last_warning TEXT;
