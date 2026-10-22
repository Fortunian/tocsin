# tocsin.sh site: minimalist landing with the exact copy, docs, status

Blocked-by: #5 (hard)

## Scope
Static site in `site/` served by the main worker at `tocsin.sh/` (Workers static assets). One page. System font stack, no external assets, no JavaScript except the copy buttons. Dark background, one accent color. Mobile at 375px with no horizontal scroll. The copy below is final and ships as written.

Landing copy, top to bottom:

```
tocsin

Security advisories, built for agents.

Your agent runs on Node, PHP, Python, Go, Rust, Ruby and the packages on top of them. When one of them ships a critical
fix, nothing tells the agent. Tocsin does. One feed. One command.

    npx tocsin connect

Wires Claude Code, Cursor, Claude Desktop and Codex to the feed in one run.

Or do it by hand:

    curl "https://tocsin.sh/v1/events?since=0&min_severity=high"
    curl "https://tocsin.sh/v1/check?node=24.22.0&php=8.4.26"
    npx tocsin check

MCP: https://mcp.tocsin.sh/mcp

Latest
[live table: 10 rows from /v1/events?limit=10, columns: when, component, CVE, severity, action]

Free. No account to read. An API key (free) for watch lists and signed webhooks.

Open source, Apache-2.0. github.com/<org>/tocsin
Built with Cromford.
docs · status · llms.txt
```

- `/docs`: one page generated from `docs/API.md` (endpoints, schema, cursor rule, rate limits, webhook signature, the connect command).
- `/status`: per-source `last_ok_at` and `last_error` from the `sources` table, plus the newest cursor. Also JSON at `/v1/status`.
- The "Built with Cromford" line links to https://cromford.dev and carries a `rel="nofollow"`-free plain link. The repo README gets the same line under a "Built with" heading.
- `tocsin.so` redirects 301 to `tocsin.sh` with the path preserved.
- Latest table is rendered in the worker from D1, cached 60 seconds in KV.

## Acceptance tests
- `tests/routes/site.test.ts`: `GET /` returns 200 HTML containing the exact strings `npx tocsin connect`, `Security advisories, built for agents.` and `Built with Cromford`; `GET /status` lists every enabled source; `GET /v1/status` is JSON with `sources[]` and `cursor`; a request with host `tocsin.so` returns 301 to `https://tocsin.sh/<path>`; the response has no `<script src=` and no `<link href="http`.
- Playwright `tests/e2e/site.spec.ts`: landing renders at 1440 and 375 with `document.documentElement.scrollWidth <= window.innerWidth`; the copy button next to `npx tocsin connect` writes it to the clipboard.

## QA screens
`/`, `/docs`, `/status`.

## Out of scope
Sign-up UI, dashboard, any pricing or billing page, analytics scripts.
