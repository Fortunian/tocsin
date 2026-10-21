# Remote MCP server at mcp.tocsin.sh

Blocked-by: #5 (hard), #6c (hard)

## Scope
- A second worker `workers/mcp/` using the Cloudflare `agents` SDK `McpAgent` with streamable HTTP transport at `https://mcp.tocsin.sh/mcp`. It calls the public API over HTTP (no shared DB binding) so the open-source MCP server works against any Tocsin host via `TOCSIN_BASE_URL`.
- Tools: `tocsin_latest({ecosystem?, min_severity?, exploited_only?, limit?})`, `tocsin_check({lockfile_name?, lockfile_text?, runtimes?})`, `tocsin_get({id_or_cve})`, `tocsin_watchlist_events({watchlist_id})` (needs the key passed as a bearer header through the MCP connection).
- Each tool result includes a `human` string (one line) and the `data` object.
- `wrangler.toml` route `mcp.tocsin.sh/*`. Add the MCP URL to `/.well-known/tocsin.json` and `llms.txt` with a copy-paste config block for Claude Code, Cursor and Claude Desktop.

## Acceptance tests
- `tests/mcp/tools.test.ts`: with the API mocked, `tocsin_latest` returns the events and a one-line `human`; `tocsin_check` with `runtimes:{node:"24.22.0"}` returns one affected item; `tocsin_get("CVE-2026-111497")` resolves by CVE.
- `tests/mcp/transport.test.ts`: `POST /mcp` with an `initialize` request returns a server info object naming `tocsin`.

## Out of scope
OAuth for MCP, per-tool billing.
