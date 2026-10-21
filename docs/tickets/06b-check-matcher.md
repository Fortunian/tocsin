# Check: version range matcher per ecosystem

Blocked-by: #1 (hard)

## Scope
Pure functions in `src/check/match/`. `isAffected(dep: Dependency, advisory: Advisory): boolean` by ecosystem:

- `semver.ts` for npm, node, deno, bun (use the `semver` package).
- `pep440.ts` for PyPI and python (implement PEP 440 comparison; no external package).
- `composer.ts` for Packagist and php (semver-like with `v` prefix and 4-part versions).
- `gomod.ts` for Go (`v`-prefixed semver, pseudo-versions compare by timestamp).
- `cargo.ts` for crates.io (semver), `gem.ts` for RubyGems (Gem::Version rules).
- The OSV `affected[]` shape is the input: `introduced`, `fixed`, `last_affected` events, where `introduced: "0"` means from the beginning.
- `src/check/match/index.ts` dispatches on ecosystem and returns `{affected: boolean, fixed_in?: string}` where `fixed_in` is the lowest fixed version above the dependency's version.

## Acceptance tests
- `tests/check/match.test.ts`: table-driven, at least 10 cases per ecosystem, including boundaries (`fixed` is exclusive, `last_affected` is inclusive), `introduced: "0"`, pre-release tags, and the real 2026-10-21 node ranges (`24.22.0` affected, `24.22.1` not, `fixed_in` is `24.22.1` for a `24.x` input and `26.12.1` for a `26.x` input).
- PEP 440 cases: `1.0.post1`, `1.0rc1`, `2024.1`, epoch `1!1.0`.

## Out of scope
Parsers, the endpoint.
