# MCP registry schema fixture

`server.schema.2025-12-11.subset.json` is NOT a verbatim copy of the registry schema.

- Source it stands in for: `internal/validators/schemas/2025-12-11.json` in
  https://github.com/modelcontextprotocol/registry, published as
  https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json.
- Why a subset: on 2026-10-23 the TCS-36 build box could not reach github.com,
  raw.githubusercontent.com, api.github.com or static.modelcontextprotocol.io
  (egress proxy answered 403). The file holds only the constraints the TCS-36
  test needs: required fields, the name pattern, the field lengths and the two
  remote transport types.
- To replace it: download the file from the URL above, save it here as
  `server.schema.2025-12-11.json`, and point `tests/cli/server-json.tcs-36.test.ts`
  at it. Record the commit sha and the fetch date in this file.

The real check is `mcp-publisher validate`, which the publish workflow runs before it publishes.
