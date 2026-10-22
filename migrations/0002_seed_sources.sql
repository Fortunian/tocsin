-- The ingester registry. INSERT OR IGNORE keeps a re-run safe.
INSERT OR IGNORE INTO sources (id, kind, enabled, config_json) VALUES
  ('osv', 'osv', 1, '{}'),
  ('nvd', 'nvd', 1, '{}'),
  ('kev', 'kev', 1, '{}'),
  ('epss', 'epss', 1, '{}'),
  ('node-runtime', 'node-runtime', 1, '{}'),
  ('php-runtime', 'php-runtime', 1, '{}');
