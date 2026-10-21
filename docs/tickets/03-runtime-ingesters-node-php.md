# Runtime ingesters: Node.js and PHP

Blocked-by: #2 (hard)

## Scope
OSV covers packages, not runtimes. These two ingesters cover the runtime itself, which is what hit on 2026-10-21.

- `src/ingest/node-runtime.ts`: reads the Node.js security release posts (nodejs.org blog feed, posts whose title contains "Security Release") and the release index `https://nodejs.org/dist/index.json`. For each CVE in a post, emits one advisory with `ecosystem="node"`, `component="node"`, `affected` ranges per release line (for example `>=24.0.0 <24.22.1`), `fixed_versions` per line, severity from the post's rating words (critical, high, medium, low), `action` "Upgrade node to <fixed for your line> or later." Source id = CVE id. Treat the post as the source of truth for fixed versions and the dist index to confirm a fixed version exists.
- `src/ingest/php-runtime.ts`: reads php.net release announcements (the releases feed) and the PHP security advisories. Emits advisories with `ecosystem="php"`, `component="php"`, affected ranges per minor line (8.2, 8.3, 8.4, 8.5), fixed versions per line, `action` "Upgrade php to <fixed for your line> or later. Unsupported lines (8.1 and older) get no fix." when the post says so.
- Both read a `last_seen` cursor from KV and skip posts older than it.
- Register both in `src/ingest/registry.ts`.

## Acceptance tests
- `tests/fixtures/node-runtime/2026-10-21.html` and `.../index.json` recorded from the real 2026-10-21 security release. `tests/ingest/node-runtime.test.ts` asserts: CVE-2026-111497 is emitted with `fixed_versions` containing `22.23.4`, `24.22.1` and `26.12.1`; severity label `high`; `affected` has three ranges; the summary is one line under 200 chars.
- `tests/fixtures/php-runtime/2026-10-21.html` recorded from php.net. `tests/ingest/php-runtime.test.ts` asserts: CVE-2026-109618 and CVE-2026-109619 are emitted with `fixed_versions` containing `8.5.12`, `8.4.27`, `8.3.36`, `8.2.35`; severity score 9.2 and label `critical`; `action` mentions that 8.1 gets no fix.
- Re-running on the same fixtures yields `unchanged` for every advisory.

## Out of scope
Go, Python, Rust, Deno, Bun runtimes (follow-up tickets with the same shape).
