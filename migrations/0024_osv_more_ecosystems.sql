-- TCS-38: the osv source reads six more OSV ecosystems: Maven, NuGet, Hex, Pub,
-- Alpine and Debian. The list is sources.config_json.ecosystems of row osv
-- (repo iron rule 5). Additive and idempotent: a name is appended only when
-- it is absent, so an edited list keeps its order and a second apply changes
-- no row. No schema change and no row is removed.

-- A row with no list reads the code fallback (DEFAULT_ECOSYSTEMS in
-- src/ingest/osv.ts). Write that list first, so the six are appended to what
-- the cron reads today.
UPDATE sources SET config_json = json_set(config_json, '$.ecosystems', json('["npm","PyPI","Go","Packagist","crates.io","RubyGems"]'))
WHERE id = 'osv' AND json_extract(config_json, '$.ecosystems') IS NULL;

UPDATE sources SET config_json = json_insert(config_json, '$.ecosystems[#]', 'Maven')
WHERE id = 'osv' AND NOT EXISTS (SELECT 1 FROM json_each(sources.config_json, '$.ecosystems') WHERE value = 'Maven');

UPDATE sources SET config_json = json_insert(config_json, '$.ecosystems[#]', 'NuGet')
WHERE id = 'osv' AND NOT EXISTS (SELECT 1 FROM json_each(sources.config_json, '$.ecosystems') WHERE value = 'NuGet');

UPDATE sources SET config_json = json_insert(config_json, '$.ecosystems[#]', 'Hex')
WHERE id = 'osv' AND NOT EXISTS (SELECT 1 FROM json_each(sources.config_json, '$.ecosystems') WHERE value = 'Hex');

UPDATE sources SET config_json = json_insert(config_json, '$.ecosystems[#]', 'Pub')
WHERE id = 'osv' AND NOT EXISTS (SELECT 1 FROM json_each(sources.config_json, '$.ecosystems') WHERE value = 'Pub');

UPDATE sources SET config_json = json_insert(config_json, '$.ecosystems[#]', 'Alpine')
WHERE id = 'osv' AND NOT EXISTS (SELECT 1 FROM json_each(sources.config_json, '$.ecosystems') WHERE value = 'Alpine');

UPDATE sources SET config_json = json_insert(config_json, '$.ecosystems[#]', 'Debian')
WHERE id = 'osv' AND NOT EXISTS (SELECT 1 FROM json_each(sources.config_json, '$.ecosystems') WHERE value = 'Debian');
