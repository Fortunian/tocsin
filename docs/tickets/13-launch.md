# Launch: real advisories in prod, README, post, public repo

Blocked-by: #3 (hard), #10 (hard), #11 (hard)

## Scope
The launch gate. Nothing here is new code beyond small text; it proves the feed is real and ships the story.

- `scripts/launch-check.sh`: against `https://tocsin.sh`, asserts `GET /v1/events/cve/CVE-2026-111497` returns fixed version `24.22.1`, `GET /v1/events/cve/CVE-2026-109618` returns `8.4.27`, `GET /v1/check?node=24.22.0` returns one affected item, `GET /status` shows every source with `last_ok_at` within 24 hours, and `npx tocsin@latest connect --dry-run` prints the MCP block. Exit 1 on any failure. This script is the acceptance test of the launch and runs in CI nightly after launch.
- `README.md` final: the three lines an agent needs, the connect command, the schema link, the self-host line (`wrangler deploy`), a "Built with" section that says the repo was built by the Cromford factory with a link, and a short "How it was built" paragraph that points at the PR list (every PR carries the harness ticket key, which is the proof).
- `docs/LAUNCH_POST.md`: the launch post in Lior's voice, about 400 words, title "Your agent's fetch() was exploitable on October 21 and nothing told it". It states the two facts (Node CVE-2026-111497 via fetch, PHP 9.2 RCEs), shows the connect command, says what is free and what is paid, and ends with the open-source link. Goes through the De-AI pass before it ships.
- `.github/ISSUE_TEMPLATE/source-request.md`: "Request a source" template so people can ask for an ecosystem.

## Acceptance tests
- `tests/launch/launch-check.test.ts` runs `scripts/launch-check.sh` against a local worker seeded with the 2026-10-21 fixtures and expects exit 0; with the node advisory removed expects exit 1.

## Out of scope
Paid ads, a newsletter, the Stripe flow (ticket 12).
