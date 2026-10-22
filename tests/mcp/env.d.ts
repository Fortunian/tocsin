import type { Env as McpEnv } from "../../workers/mcp/src/env";

// The mcp test project runs the MCP worker (workers/mcp/wrangler.toml), which
// has its own bindings. Typed by workers/mcp/tsconfig.json.
declare global {
  namespace Cloudflare {
    interface Env extends McpEnv {}
    interface GlobalProps {
      mainModule: typeof import("../../workers/mcp/src/index");
    }
  }
}
