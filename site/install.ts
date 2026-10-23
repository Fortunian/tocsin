// "Add to Cursor" and "Add to VS Code": one-click install links built from the
// same config object `tocsin connect --print` prints, so the three never drift.
import { MCP_SERVER_NAME, mcpServerConfig } from "../packages/cli/src/mcp-config";
import { escapeHtml } from "./layout";

// Cursor: config is base64 of the JSON, percent-encoded (base64 has + / =).
export function cursorInstallUrl(): string {
  const config = encodeURIComponent(btoa(JSON.stringify(mcpServerConfig())));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${config}`;
}

// VS Code: the query is the URL-encoded JSON of the name plus the config.
export function vscodeInstallUrl(): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: MCP_SERVER_NAME, ...mcpServerConfig() }))}`;
}

export function installLinks(): string {
  return `<p class="install"><a class="install-link" href="${escapeHtml(cursorInstallUrl())}">Add to Cursor</a> <a class="install-link" href="${escapeHtml(vscodeInstallUrl())}">Add to VS Code</a></p>`;
}
