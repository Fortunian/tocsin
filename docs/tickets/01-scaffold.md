# Scaffold: worker, D1 schema, advisory schema v1, CI

## Scope
Create the project skeleton so every later ticket builds on one shape.

- `package.json`, `tsconfig.json`, `wrangler.toml` (worker `tocsin`, D1 binding `DB`, KV binding `CURSORS`, queue `deliveries`, cron `*/10 * * * *`).
- Hono app in `src/app.ts`, entry `src/index.ts` with `fetch`, `scheduled`, `queue` handlers that delegate to `src/cron/run.ts` and `src/queue/run.ts` (both stubs that log and return).
- `GET /v1/health` returns `{ ok: true, version }`.
- `schema/advisory.v1.json` (JSON Schema) and `src/schema/advisory.ts` (TypeScript type + a `validateAdvisory()` built from the JSON Schema with ajv). Fields: `id` (tocsin id, `tcs_` + ulid), `cve_ids[]`, `ghsa_id?`, `ecosystem`, `component` (package name or runtime name), `affected[]` (`{introduced?, fixed?, last_affected?}` ranges, OSV shape), `fixed_versions[]`, `severity` (`{score?, label: critical|high|medium|low|unknown}`), `exploited` (bool, from KEV), `epss?` (0..1), `published_at`, `modified_at`, `summary` (one line, max 200 chars), `action` (one line, max 200 chars, for example "Upgrade node to 24.22.1 or later."), `references[]`, `sources[]` (`{source, source_id, url}`).
- `migrations/0001_init.sql`: tables `sources(id TEXT PK, kind, enabled INT, config_json, last_run_at, last_ok_at, last_error)`, `advisories(id TEXT PK, cve_primary, ecosystem, component, severity_label, severity_score, exploited, epss, published_at, modified_at, doc_json, cursor INTEGER UNIQUE)`, `advisory_sources(source, source_id, advisory_id, PK(source, source_id))`. Indexes: `advisories(cursor)`, `advisories(ecosystem, cursor)`, `advisories(component, ecosystem)`, `advisories(cve_primary)`, `advisory_sources(advisory_id)`. `cursor` is a monotonic integer assigned on insert and on content change (so `since=` works).
- Seed rows in `migrations/0002_seed_sources.sql` for `osv`, `nvd`, `kev`, `epss`, `node-runtime`, `php-runtime` (all `enabled=1`, empty config).
- `.env.example` with every variable (`NVD_API_KEY=`, `GITHUB_TOKEN=`).
- `.github/workflows/ci.yml`: install, typecheck, test on every PR; deploy with `wrangler deploy` on push to `main` (secret `CLOUDFLARE_API_TOKEN`).
- `README.md`: what Tocsin is, the curl one-liner, how to run locally.
- Retention rule documented in `docs/RETENTION.md`: advisories are kept forever; `sources.last_error` is overwritten, never appended.

## Acceptance tests
- `tests/health.test.ts`: `GET /v1/health` returns 200 and `{ok:true}`.
- `tests/schema.test.ts`: a fixture advisory validates; a record missing `ecosystem` fails; `summary` over 200 chars fails.
- `tests/migrations.test.ts`: applying all migrations to a fresh local D1 succeeds; `EXPLAIN QUERY PLAN SELECT * FROM advisories WHERE cursor > ? ORDER BY cursor LIMIT 100` uses the `cursor` index (assert the plan string contains `USING INDEX`).

## Out of scope
Any ingester, any feed route beyond health, the site.
