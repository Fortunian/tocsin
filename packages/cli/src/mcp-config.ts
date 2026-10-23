// The one MCP server config. `tocsin connect --print` prints it, and the site's
// "Add to Cursor" and "Add to VS Code" links encode it (site/install.ts).
// No imports: the main worker bundles this file too.

export const DEFAULT_MCP_URL = "https://mcp.tocsin.sh/mcp";
export const MCP_SERVER_NAME = "tocsin";

export function mcpServerConfig(url: string = DEFAULT_MCP_URL) {
  return { type: "http", url } as const;
}
