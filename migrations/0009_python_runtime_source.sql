-- TCS-39: the python-runtime source (CPython, from the PSF advisory database).
-- Additive: INSERT OR IGNORE keeps a re-run safe and never edits an existing row.
-- config_json '{}' uses the code fallbacks in src/ingest/python-runtime.ts (PY_DEFAULTS).
INSERT OR IGNORE INTO sources (id, kind, enabled, config_json) VALUES
  ('python-runtime', 'python-runtime', 1, '{}');
