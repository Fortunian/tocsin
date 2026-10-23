# TCS-36 plan: MCP registry server.json, Smithery manifest, Add-to-Cursor and Add-to-VS Code links

Ticket: Fortunian/tocsin#36. Read on 2026-10-23 with its full thread. The thread has 0 comments, so the issue body is the spec.
Blocked-by: #12 (CLOSED) and #35 (CLOSED). The ticket is buildable.
Already on main? I ran `git log origin/main --since=2026-10-22T21:15:59Z`. It shows 14 commits (TCS-30, 50, 46, 49, 39, 33, 34, 40, 35). None of them adds `mcp/server.json`, `smithery.yaml`, a registry workflow or install links. `ls mcp` on main: no such directory. Nothing is done yet.
CodeGraph: NOT AVAILABLE on this box. I found callers with grep and by reading the files (see the files-to-touch list).
Verification map: ABSENT in this repo. I found the routes by reading `src/routes/site.ts`.

CROSS-REPO-READ: modelcontextprotocol/registry

## Spec changes from comments
none

## Scope
1. `mcp/server.json`: the official MCP registry format (schema `2025-12-11`, the registry's `CurrentSchemaVersion` in `pkg/model/constants.go`). Name `sh.tocsin/tocsin`. One remote `{ "type": "streamable-http", "url": "https://mcp.tocsin.sh/mcp" }`. No headers, so no auth.
2. `.github/workflows/publish-mcp-registry.yml`: `workflow_dispatch` only. It validates `mcp/server.json`, logs in and runs `mcp-publisher publish`. The login method is an ASSUMPTION (A1): it is DNS, not GitHub OIDC.
3. `smithery.yaml`: a remote server with no config. The format is an ASSUMPTION (A2).
4. One shared config module, used by the CLI's `connect --print` and by the site's two install links:
   - `packages/cli/src/mcp-config.ts` (new, no imports): `DEFAULT_MCP_URL` and `mcpServerConfig(url)`, which returns `{ type: "http", url }`.
   - `connect.ts` imports both. It still exports `DEFAULT_MCP_URL`, so existing imports keep working.
   - `site/install.ts` (new): `cursorInstallUrl()`, `vscodeInstallUrl()` and `installLinks()` (the HTML). All three are built from `mcpServerConfig(DEFAULT_MCP_URL)`.
5. The landing page (`/`) and the docs page (`/docs`) show "Add to Cursor" and "Add to VS Code" next to `npx tocsin connect`.
6. A "Directories" section in `README.md`: the registry name and the Smithery state ("not listed yet", because no listing exists yet. D26: no invented URL).

Out of scope (from the ticket): submitting to directories that take a human form.

## Files to touch
- `packages/cli/src/mcp-config.ts` (new): the one config object.
- `packages/cli/src/connect.ts`: use `mcp-config.ts` for `DEFAULT_MCP_URL` and the `generic` entry. The `--print` output does not change byte for byte. Callers: `packages/cli/src/cli.ts` (runConnect) and `tests/cli/connect.tcs-13.test.ts` (asserts the print block). Both are regression risks, and neither changes.
- `site/install.ts` (new): link builders and button HTML.
- `site/landing.ts`: insert `installLinks()` right after `command("npx tocsin connect")`. The client's copy text does not change (the TCS-10 rule: "Do not reword it").
- `site/docs.ts`: `renderDocs()` inserts `installLinks()` right after the generated `<pre><code>npx tocsin connect</code></pre>` block in `DOCS_HTML`. `docs/API.md` and `site/docs.generated.ts` do not change, so `gen:docs --check` stays green.
- `site/layout.ts`: CSS only. Add an `.install` row (flex, `flex-wrap: wrap`, min height 40px links styled like the copy button). No change to `COPY_JS` and no new script.
- `mcp/server.json` (new).
- `smithery.yaml` (new, repo root).
- `.github/workflows/publish-mcp-registry.yml` (new).
- `README.md`: the "Directories" section.
- `tests/fixtures/mcp-registry/server.schema.2025-12-11.json` (new): a verbatim copy of `internal/validators/schemas/2025-12-11.json` from modelcontextprotocol/registry, with its `$id` `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`.
- `tests/fixtures/mcp-registry/README.md` (new): source URL, commit sha and fetch date of the fixture.
- `tests/cli/server-json.tcs-36.test.ts` (new): the server.json, wrangler and workflow test (Node, ajv). See A3 for why it is under `tests/cli/`.
- `tests/cli/connect-print.tcs-36.test.ts` (new): `connect --print` equals the shared object and the decoded links.
- `tests/routes/site-install-links.tcs-36.test.ts` (new): `/` and `/docs` through `SELF` (the production entry point).

## Verify (run, not edited)
- `npm test` (all four vitest projects)
- `npm run typecheck` (root, workers/mcp, packages/cli, action)
- `npm run gen:docs -- --check`, `npm run gen:schema -- --check`
- `npx wrangler deploy --dry-run --outdir /tmp/tcs36-dry` (proves esbuild resolves `site/install.ts -> packages/cli/src/mcp-config.js`)
- `cd packages/cli && npm run build` (proves the CLI still builds with `rootDir: src`)
- `npx playwright test tests/e2e/site.spec.ts` if a browser exists on the box. If not: `[NOTE] not verified here: e2e 390px no-scroll`.

## Sibling claims (not touched)
TCS-41 is live. It claims `tests/routes/site.tcs-10.test.ts`, `tests/routes/site-freshness.tcs-35.test.ts`, `src/ingest/*`, `migrations/0013_*`, `docs/RETENTION.md` and others. This plan edits none of them. TCS-41 does not claim `site/landing.ts` or `site/layout.ts`. The TCS-10 landing test checks the copy as an ordered subsequence (`indexOf` from the last position), so new link text between lines does not break it. I checked lines 57-95 of that test.
Open PR #31 (TCS-14) edits `vitest.config.ts`. This plan does not edit `vitest.config.ts` (A3).

## Tasks

### T1. Shared config module and the CLI's use of it
Create `packages/cli/src/mcp-config.ts`:
```ts
export const DEFAULT_MCP_URL = "https://mcp.tocsin.sh/mcp";
export const MCP_SERVER_NAME = "tocsin";
export function mcpServerConfig(url: string = DEFAULT_MCP_URL) { return { type: "http", url } as const; }
```
In `connect.ts`: `import { DEFAULT_MCP_URL, mcpServerConfig } from "./mcp-config.js"`, `export { DEFAULT_MCP_URL }`, and `const generic = mcpServerConfig(mcpUrl)`. The Claude Code target entry `{ type: "http", url: mcpUrl }` also uses `mcpServerConfig(mcpUrl)`. The Cursor, Desktop and Codex entries do not change.
VALIDATE: `npx vitest run --project cli tests/cli/connect.tcs-13.test.ts tests/cli/connect-print.tcs-36.test.ts` exits 0, and `cd packages/cli && npm run build` exits 0.
SATISFIES: "generated from one config object so the three never drift" (Scope 3).

### T2. Install links on the landing and docs pages
`site/install.ts`:
- `cursorInstallUrl()` = `cursor://anysphere.cursor-deeplink/mcp/install?name=tocsin&config=` + `encodeURIComponent(btoa(JSON.stringify(mcpServerConfig())))`.
- `vscodeInstallUrl()` = `vscode:mcp/install?` + `encodeURIComponent(JSON.stringify({ name: "tocsin", ...mcpServerConfig() }))`.
- `installLinks()` = `<p class="install"><a class="install-link" href="…">Add to Cursor</a> <a class="install-link" href="…">Add to VS Code</a></p>`. Each href goes through `escapeHtml`.
Insert it in `renderLanding` after `command("npx tocsin connect")`. In `renderDocs`, insert it after the first `<pre><code>npx tocsin connect</code></pre>`. If that marker is missing, `renderDocs` appends nothing. The test pins that the marker is present, so a docs edit that drops it goes red.
Add `.install` CSS in `layout.ts`: flex with wrap, gap 8px, links min-height 40px, accent border. It must not cause horizontal scroll at 375px.
VALIDATE: `npx vitest run --project api tests/routes/site-install-links.tcs-36.test.ts tests/routes/site.tcs-10.test.ts` exits 0.
SATISFIES: "On the landing and docs pages: 'Add to Cursor' … and 'Add to VS Code' … buttons next to `npx tocsin connect`".

### T3. Registry manifest and fixture
Write `mcp/server.json`:
```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "sh.tocsin/tocsin",
  "title": "Tocsin",
  "description": "Security advisories, built for agents.",
  "version": "<root package.json version, the version the MCP worker reports>",
  "websiteUrl": "https://tocsin.sh",
  "repository": { "url": "https://github.com/Fortunian/tocsin", "source": "github" },
  "remotes": [{ "type": "streamable-http", "url": "https://mcp.tocsin.sh/mcp" }]
}
```
Fetch the schema with `gh api repos/modelcontextprotocol/registry/contents/internal/validators/schemas/2025-12-11.json` and write it verbatim to the fixture. It is draft-07, so the default `new Ajv({ strict: false })` plus `ajv-formats` (if `format: uri` needs it) applies. If `ajv-formats` is not installed, use `ajv.addFormat("uri", …)` with `new URL()`, not a new dependency. If ajv rejects a field above, drop the field. Never loosen the schema.
VALIDATE: `npx vitest run --project cli tests/cli/server-json.tcs-36.test.ts` exits 0.
SATISFIES: "`mcp/server.json` in the official MCP registry schema (name `sh.tocsin/tocsin`, remote streamable HTTP at https://mcp.tocsin.sh/mcp, no auth required)".

### T4. Publish workflow
`.github/workflows/publish-mcp-registry.yml`:
- `on: workflow_dispatch` only. `permissions: contents: read`.
- Steps: checkout, then download `mcp-publisher` at a PINNED release tag (v1.8.1 is latest as of 2026-10-23; recheck at build time). Do not use `latest/download`.
- Then `./mcp-publisher validate mcp/server.json`, then the login, then `./mcp-publisher publish mcp/server.json`.
- Login (A1): `./mcp-publisher login dns --domain=tocsin.sh --private-key="$MCP_REGISTRY_DNS_KEY"`, with `env: MCP_REGISTRY_DNS_KEY: ${{ secrets.MCP_REGISTRY_DNS_KEY }}`. Before the login, a guard step exits 1 with a clear message if the secret is empty. The secret goes through `env:`, never interpolated into `run:`.
VALIDATE: `npx vitest run --project cli tests/cli/server-json.tcs-36.test.ts` exits 0 (the workflow assertions in that file).
SATISFIES: "a `publish-mcp-registry.yml` workflow (manual dispatch) that validates it and runs `mcp-publisher publish`".

### T5. Smithery manifest
Write `smithery.yaml` at the repo root. Use only keys a live Smithery source documents at build time. Try `npx -y @smithery/cli --help` and the Smithery docs. If no source documents a file format for an externally hosted URL server, write a comment-only file. The comment names the URL, says that no config is needed, and gives the publish path the docs give (smithery.ai/new, or `smithery mcp publish <url>` if `--help` confirms it). Invent no keys (D26).
VALIDATE: `node -e "require('yaml').parse(require('fs').readFileSync('smithery.yaml','utf8'))"` exits 0, and `grep -c "https://mcp.tocsin.sh/mcp" smithery.yaml` prints 1 or more.
SATISFIES: "`smithery.yaml` for Smithery (remote server, no config)".

### T6. README "Directories"
Add a `## Directories` section. Content: the registry name `sh.tocsin/tocsin`, how to publish (run the workflow), the operator steps (DNS TXT record and the `MCP_REGISTRY_DNS_KEY` secret), and "Smithery: not listed yet".
VALIDATE: `grep -n "## Directories" README.md && grep -n "sh.tocsin/tocsin" README.md` prints both lines.
SATISFIES: "README section 'Directories' with the registry name and the Smithery page once listed".

## Changed symbols
- function `runConnect`: the `--print` block and the Claude Code entry come from `mcpServerConfig()`. The output is the same. callers: left alone: `cli.ts` calls it with the same signature.
- function `DEFAULT_MCP_URL` (const): moves to `mcp-config.ts`, and `connect.ts` re-exports it. callers: left alone: the re-export keeps every import path valid.
- function `mcpServerConfig`: new.
- function `cursorInstallUrl`, `vscodeInstallUrl`, `installLinks`: new.
- function `renderLanding`: adds the install links after the connect command.
- function `renderDocs`: inserts the install links after the connect block.
- route `GET /`: the HTML gains two links.
- route `GET /docs`: the HTML gains two links.
- format `mcp/server.json`: new file.
- format `smithery.yaml`: new file.

## Design collisions
- `GET /`: combine — PR #31 commit 3dcc73db75bf changes only `README.md`. It deletes the README line that names `GET /` and leaves `src/routes/site.ts` and `site/landing.ts` as they are, so T2's install links in `renderLanding` do not conflict. The only overlap is T6: add `## Directories` as a new section between `## Layout` and `## License` in whichever README is on main at build time (#31's rewrite or the current one), and do not restore the line #31 removed.

## ASSUMPTIONS
- A1 (registry login). The ticket asks for name `sh.tocsin/tocsin` AND "the repo's GitHub OIDC identity". These two conflict. The registry docs (`docs/reference/cli/commands.md`) say `login github-oidc` grants only `io.github.{username}/*` and `io.github.{org}/*`. A `sh.tocsin/*` name needs DNS or HTTP verification of tocsin.sh. I kept the name, because it is client-visible and permanent once published. The workflow logs in with `login dns --domain=tocsin.sh`, using the secret `MCP_REGISTRY_DNS_KEY`. Operator steps: make an ed25519 key, add the TXT record `tocsin.sh. IN TXT "v=MCPv1; k=ed25519; p=<pubkey>"`, and set the repo secret. Other reading: name `io.github.fortunian/tocsin` with `login github-oidc` and `permissions: id-token: write`, which needs no operator setup. To switch: change one name field and one login line.
- A2 (Smithery). Smithery's current docs (smithery.ai/docs/build/publish and llms.txt, read 2026-10-23) do not document a `smithery.yaml` for an externally hosted URL server. Such a server is listed at smithery.ai/new or with `smithery mcp publish`. I ship the file the ticket names, with only the keys a live source confirms at build time, or else comments only. Other reading: the legacy `startCommand: { type: http }` form. That form tells Smithery to build and host the code, which this server does not want.
- A3 (test location). The ticket names `tests/mcp/server-json.tcs-NN.test.ts`. The `mcp` vitest project runs in workerd, where ajv's compile (`new Function`) is blocked. `tests/mcp` is also typechecked with workers types only, so it has no `node:fs`. Moving the test there needs edits to `vitest.config.ts` (also edited by open PR #31) and two tsconfigs. I put it in the existing Node project as `tests/cli/server-json.tcs-36.test.ts`. The assertions are the ones the ticket asks for. Other reading: add a Node vitest project for `tests/mcp/server-json.*`.
- A4 (Cursor config shape). The Cursor link encodes the same object `connect --print` prints (`{ "type": "http", "url": … }`), as the ticket's test requires. `connect` writes Cursor's own `mcp.json` entry as `{ url }`. Cursor accepts `type` on remote entries, and the ticket requires equality. Other reading: encode `{ url }` only, and compare only `url`.
- A5 (VS Code link). `vscode:mcp/install?<urlencoded JSON>` carries `name` plus the config. The test removes `name` and compares the rest to the print block.
- A6 (docs page). The docs body is generated from `docs/API.md`. I insert the links in `renderDocs()` after the generated connect block, not in the markdown. This keeps one config source and `gen:docs --check` unchanged.

## Edge cases
- `TOCSIN_MCP_URL` env override: `connect --print` honours it, and the site does not. The cross-test runs with the env var unset and compares against the default URL. This is the case the ticket names.
- base64 has `+ / =`. They must be percent-encoded in the Cursor query. The test decodes with `URLSearchParams` then `atob`, and fails if they are not encoded.
- `escapeHtml` on the href turns `&` into `&amp;`. The test reads the href from HTML, so it must unescape `&amp;` before parsing.
- 375px: the two links wrap. No body horizontal scroll.
- The docs marker is missing (a future API.md edit): the test goes red. Nothing is silently dropped.

## Iron laws: how they apply
- Schema, indexes, retention, RLS: none. No table, no migration, no query.
- DB-driven config and hardcoded-knob: no limit, rate, timeout or cap is added. The MCP URL is an identity constant that already exists in `connect.ts`. It moves, it is not new.
- Model id, LLM, De-AI, metered calls, dedup-before-spend: none.
- Scalable tests: no vendor is called in a test. The registry and Smithery are only used by the manual workflow. The tests read local files and fixtures only. No seam is needed.
- UI rules: no table and no card. The links are `<a>` elements, so they need no new script and no native dialog. 375px is checked.
- Secrets: the workflow reads the key from `secrets` through `env:`. Nothing is committed.
- Performance: the landing loader is unchanged. The links are static strings computed per render, with 0 new reads and 0 new statements. Loading skeleton: n/a, because this is a Worker HTML page with no new data.

## Build-discipline rules that bite
- D2: `site-install-links` goes through `SELF.fetch("/")` and `SELF.fetch("/docs")`. Deleting the insert in `landing.ts` or `docs.ts` must fail it.
- D1: mutate one link's URL, or `mcpServerConfig`'s `type`, and confirm a test goes red.
- D3: tests parse the hrefs and the JSON. They never use a regex over source.
- D26: no invented Smithery page URL, no invented smithery.yaml keys, and a schema fixture copied verbatim with its source.
- D8: the operator steps for A1 go in the PR body.
- D25: no change to `docs.generated.ts`, `vitest.config.ts` or `package-lock.json`.

```pr-body-requires
## ASSUMPTIONS <- plan ASSUMPTIONS section (copied verbatim)
## Operator steps <- A1 (DNS TXT record + MCP_REGISTRY_DNS_KEY secret), out-of-scope directory submissions
```

## System invariants
- (a) Cross-run state: none. No store, no dedup and no watermark.
- (b) External side effects: only the manual workflow publishes. Order: validate, then login, then publish, and any failing step stops the job. If the secret is missing, the guard step exits 1 before login. The workflow never reports success without a publish.
- (c) Classifier: none.
- (d) Neighbors: the `ci.yml` deploy job is untouched. The new workflow has no `push` or `pull_request` trigger, so it never runs on PRs. `tocsin.yml` (the Action) is untouched. The CLI `--print` output is byte-identical, and `connect.tcs-13` pins that.

## Requirements coverage
| Requirement (ticket) | Task | Test |
|---|---|---|
| server.json in the registry schema, name `sh.tocsin/tocsin` | T3 | server-json.tcs-36: ajv valid; `name === "sh.tocsin/tocsin"` |
| remote streamable HTTP at https://mcp.tocsin.sh/mcp | T3 | server-json.tcs-36: `remotes[0]` type and url |
| no auth required | T3 | server-json.tcs-36: no `headers` and no `variables` on the remote |
| URL equals the custom domain in workers/mcp/wrangler.toml | T3 | server-json.tcs-36: `https://${routes pattern}/mcp === remotes[0].url === DEFAULT_MCP_URL` |
| workflow, manual dispatch, validates, publishes | T4 | server-json.tcs-36: `on` keys are exactly `workflow_dispatch`; step order validate < publish; secret through env |
| "with GitHub OIDC" | T4 (A1: DNS instead) | server-json.tcs-36 pins the dns login; A1 in the PR body |
| smithery.yaml, remote, no config | T5 | T5 VALIDATE (parses, names the URL) |
| Add to Cursor on landing and docs | T2 | site-install-links.tcs-36 |
| Add to VS Code on landing and docs | T2 | site-install-links.tcs-36 |
| one config object, the three never drift | T1, T2 | connect-print.tcs-36 + site-install-links.tcs-36 |
| links decode to the same config as `connect --print` | T1, T2 | connect-print.tcs-36 |
| README "Directories" | T6 | T6 VALIDATE grep |
| NEGATIVE: no human-form directory submission | none (nothing built) | n/a: the PR adds no code that submits anywhere |
| NEGATIVE: landing copy not reworded | T2 | site.tcs-10 "ships the landing copy verbatim and in order" stays green |

## Acceptance tests
- `tests/cli/server-json.tcs-36.test.ts` (vitest, project `cli`, Node):
  1. `mcp/server.json` validates with ajv against `tests/fixtures/mcp-registry/server.schema.2025-12-11.json`, and `$schema` equals the fixture's `$id`.
  2. `name === "sh.tocsin/tocsin"`, `remotes.length === 1`, `remotes[0].type === "streamable-http"`, and there are no `headers` or `variables`.
  3. It reads `workers/mcp/wrangler.toml` and extracts `pattern = "…"` from `routes`, with `custom_domain = true`. Then `remotes[0].url === "https://" + pattern + "/mcp"`, and that equals `DEFAULT_MCP_URL` from `packages/cli/src/mcp-config.ts`.
  4. A negative: a copy with `remotes[0].type = "http"` fails validation. This proves the validator really checks.
  5. The workflow YAML parsed: `Object.keys(on)` equals `["workflow_dispatch"]`. One step runs `mcp-publisher validate mcp/server.json` and a later one runs `mcp-publisher publish mcp/server.json`. No `run:` contains `${{ secrets.`. The download URL has no `latest/`.
  6. `version` equals the root `package.json` version.
- `tests/cli/connect-print.tcs-36.test.ts` (project `cli`):
  1. `main(["connect","--print"])` with a fake io and no `TOCSIN_MCP_URL`. The parsed `mcpServers.tocsin` deep-equals `{ type: "http", url: "https://mcp.tocsin.sh/mcp" }` and `mcpServerConfig()`.
  2. `cursorInstallUrl()`: the scheme and path are `cursor://anysphere.cursor-deeplink/mcp/install`, `name=tocsin`, and `JSON.parse(atob(config))` deep-equals the printed block.
  3. `vscodeInstallUrl()`: it starts with `vscode:mcp/install?`. The decoded JSON minus `name` deep-equals the printed block, and `name === "tocsin"`.
- `tests/routes/site-install-links.tcs-36.test.ts` (project `api`, through `SELF`):
  1. `GET /` has an `<a>` with text "Add to Cursor" and one with "Add to VS Code". Both appear after `data-copy="npx tocsin connect"` and before "Wires Claude Code". Their unescaped hrefs decode to `{ type: "http", url: "https://mcp.tocsin.sh/mcp" }`.
  2. `GET /docs`: the same two links, after the `npx tocsin connect` code block, and decoding to the same object.
  3. The decoded Cursor config from `/` deep-equals `mcpServerConfig()`. This is the drift guard against the shared module.

Regression risk: `tests/routes/site.tcs-10.test.ts` (landing copy order, copy button), `tests/routes/site-freshness.tcs-35.test.ts`, `tests/cli/connect.tcs-13.test.ts` (the print block and the Claude Code entry), `tests/e2e/site.spec.ts` (no horizontal scroll at 390px), and `tests/routes/site-plan.tcs-10.test.ts`.

## QA screens
- `/` at 1440px and 375px: the two links show under `npx tocsin connect`, they wrap, and there is no horizontal scroll. Clicking "Add to Cursor" opens the `cursor://` URL (in headless the check is the href only).
- `/docs` at 1440px and 375px: in "Connect command", the two links show after the `npx tocsin connect` block.

## Design collision check (BH-5791)

Checked 10 listed and 0 derived symbols against main 07a977891e95..07a977891e95 and 1 open PRs.
- `GET /` (function, listed): PR #31 3dcc73db75bf, (text match). Resolution: combine.

## Size
FILES: 9
LINES: 160
DIFF_KB: 40

KIND: feature
SIZE: M
