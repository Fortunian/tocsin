# Check: lockfile and runtime parsers

Blocked-by: #1 (hard)

## Scope
Pure functions, no I/O, in `src/check/parsers/`. Each takes file text and returns `Dependency[] = {ecosystem, name, version}[]`.

- `package-lock.ts` (v2 and v3 `packages` map), `pnpm-lock.ts` (yaml, `packages:` keys), `yarn-lock.ts` (v1 text and berry yaml), `requirements.ts` (`name==version` lines only; skip ranges and report them in `skipped[]`), `go-sum.ts` (module@version lines, drop `/go.mod` suffix duplicates), `composer-lock.ts` (`packages` and `packages-dev`), `cargo-lock.ts`, `gemfile-lock.ts`.
- `runtimes.ts`: accepts `{node?, php?, python?, go?, deno?, bun?}` version strings and returns dependencies with `ecosystem` equal to the runtime name and `name` equal to the runtime name.
- `src/check/parsers/index.ts`: `detect(filename, text)` picks the parser from the filename.

## Acceptance tests
- One fixture per parser in `tests/fixtures/lockfiles/`, recorded from real projects, each with at least 20 entries. `tests/check/parsers.test.ts` asserts the entry count, one known `(name, version)` pair per fixture, and that `detect()` returns the right parser for each filename.
- `requirements.txt` with `requests>=2.0` lands in `skipped[]`, not in the result.

## Out of scope
Range matching, the HTTP endpoint, SBOM (CycloneDX, SPDX) input.
