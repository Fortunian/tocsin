# Check endpoint: am I affected?

Blocked-by: #5 (hard), #6a (hard), #6b (hard)

## Scope
- `POST /v1/check` accepts either `multipart/form-data` with one or more lockfiles (field name = filename) or JSON `{ dependencies: Dependency[], runtimes: {...} }`. Body cap 2 MB. Parses with `src/check/parsers`, loads candidate advisories by `(ecosystem, component)` in one batched query (`WHERE (ecosystem, component) IN (...)`, chunks of 200), matches with `src/check/match`, returns `{ checked: n, affected: [{dependency, advisory_id, cve_ids, severity, exploited, fixed_in, action, url}], skipped: [...] }` sorted by severity then exploited.
- `GET /v1/check?node=24.22.0&php=8.4.26` is the no-body shortcut for runtimes only.
- Response includes `feed_cursor` so an agent can poll `/v1/events?since=` for anything new after the check.
- Anonymous rate limit 20 checks per minute per IP.
- Add the check endpoint to `llms.txt` and `/.well-known/tocsin.json`.

## Acceptance tests
- `tests/routes/check.test.ts`: seed the 2026-10-21 node and php advisories plus 3 npm advisories. A `package-lock.json` fixture containing one affected and one safe package returns exactly one affected item with `fixed_in`; `GET /v1/check?node=24.22.0` returns CVE-2026-111497 with `fixed_in=24.22.1`; `?node=24.22.1` returns an empty `affected`; a 3 MB body returns 413; a lockfile with an unknown name returns 400 with the list of supported filenames.
- `tests/routes/check-plan.test.ts`: the candidate query uses `advisories(component, ecosystem)`.

## Out of scope
Saving the lockfile as a watch list (ticket #7), SBOM formats.
