# Ingest framework + OSV ingester

Blocked-by: #1 (hard)

## Scope
- `src/ingest/types.ts`: `interface Ingester { id: string; run(ctx): Promise<RunResult> }` where `RunResult = { fetched, upserted, unchanged, errors[] }`.
- `src/ingest/registry.ts`: a map from `sources.id` to ingester. The cron reads enabled rows from `sources`, runs each ingester in sequence, writes `last_run_at`, `last_ok_at`, `last_error`. One failure never stops the others.
- `src/ingest/upsert.ts`: `upsertAdvisory(doc, {source, source_id})`. Looks up `advisory_sources(source, source_id)`. If present and the normalized `doc_json` is byte-equal, counts `unchanged`. If present and changed, updates the row and assigns a new `cursor`. If absent, inserts with a new id and cursor. Cross-source merge: if a different source already created an advisory with the same primary CVE, attach to that advisory instead of inserting a second one, and merge `references` and `sources`.
- `src/ingest/osv.ts`: pulls modified advisories from OSV for ecosystems `npm`, `PyPI`, `Go`, `Packagist`, `crates.io`, `RubyGems` using the OSV API with a `modified_since` cursor stored in KV (`cursor:osv`). Normalizes OSV JSON to advisory v1: affected ranges, fixed versions from `events.fixed`, severity from `severity[]` CVSS when present, `action` text "Upgrade <component> to <lowest fixed> or later." when a fixed version exists, else "No fix published. Pin and monitor."
- `src/cron/run.ts` calls the registry.
- Cursor advance is written only after a fully successful page.

## Acceptance tests
- `tests/ingest/upsert.test.ts`: inserting the same `(source, source_id)` twice yields one row and `unchanged=1`; a changed doc gets a higher `cursor`; two sources with the same CVE yield one advisory with two `advisory_sources` rows.
- `tests/ingest/osv.test.ts`: with the fixture `tests/fixtures/osv/page1.json` (recorded from OSV, at least 5 advisories across 3 ecosystems) the ingester produces valid v1 docs; `action` is set for each with a fixed version; the KV cursor equals the max `modified` in the page after a successful run; a thrown error on page 2 leaves the cursor at page 1's value.
- `tests/cron/run.test.ts`: a registry with one failing and one passing ingester runs both and records `last_error` on the failing source only.

## Out of scope
NVD, KEV, EPSS, runtime ingesters, the feed route.
