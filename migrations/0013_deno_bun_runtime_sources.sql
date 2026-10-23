-- TCS-41: the deno-runtime and bun-runtime sources (GitHub repository security advisories).
-- Additive: INSERT OR IGNORE keeps a re-run safe and never edits an existing row.
-- config_json '{}' uses the code fallbacks in src/ingest/deno-runtime.ts (DENO_DEFAULTS)
-- and src/ingest/bun-runtime.ts (BUN_DEFAULTS).
INSERT OR IGNORE INTO sources (id, kind, enabled, config_json) VALUES
  ('deno-runtime', 'deno-runtime', 1, '{}'),
  ('bun-runtime', 'bun-runtime', 1, '{}');
