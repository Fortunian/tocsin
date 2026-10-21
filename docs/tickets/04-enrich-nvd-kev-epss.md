# Enrichment: NVD severity, CISA KEV exploited flag, EPSS score

Blocked-by: #2 (hard)

## Scope
- `src/ingest/nvd.ts`: for advisories with a CVE but no severity score, query NVD API 2.0 by CVE id (batched, respecting the 50 requests per 30 seconds limit with the API key from `NVD_API_KEY`). Writes `severity.score` and label. Dedup before spend: skip any CVE that already has a score or was queried in the last 24 hours (KV key `nvd:queried:<cve>`).
- `src/ingest/kev.ts`: downloads the CISA KEV JSON feed once per run and sets `exploited=true` on every matching advisory. A newly exploited advisory gets a new `cursor` so subscribers see it again.
- `src/ingest/epss.ts`: downloads the daily EPSS CSV once per run and writes `epss` for matching advisories. An EPSS change alone does not bump `cursor` (too noisy); it is read on the next content change.
- Severity label mapping lives in `src/schema/severity.ts`: critical >= 9.0, high >= 7.0, medium >= 4.0, low > 0.

## Acceptance tests
- `tests/ingest/nvd.test.ts`: with a fixture response, a scoreless advisory gets score 9.2 and label critical; a second run makes zero HTTP calls (assert the fetch mock call count is 0).
- `tests/ingest/kev.test.ts`: fixture KEV feed with one matching CVE sets `exploited=true` and bumps the cursor; a non-matching run changes nothing.
- `tests/ingest/epss.test.ts`: fixture CSV sets `epss` within 0..1 and does not change the cursor.
- `tests/schema/severity.test.ts`: boundary values 9.0, 7.0, 4.0, 0.1, 0 map to the expected labels.

## Out of scope
GitHub Advisory Database as a separate source (OSV already mirrors GHSA).
