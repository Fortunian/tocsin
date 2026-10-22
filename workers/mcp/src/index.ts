// The Tocsin MCP server (mcp.tocsin.sh). Streamable HTTP at /mcp, one Durable
// Object per MCP session. It reads the public Tocsin API over HTTP only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import pkg from "../../../package.json";
import { TocsinApi } from "./api";
import type { Env, Props } from "./env";
import {
  check,
  checkInput,
  get,
  getInput,
  latest,
  latestInput,
  toCallToolResult,
  watchlistEvents,
  watchlistInput,
  type ToolResult,
} from "./tools";

const DEFAULT_BASE_URL = "https://tocsin.sh";

// The token from "Authorization: Bearer <token>", or null for anything else.
export function parseBearer(header: string | null | undefined): string | null {
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1] : null;
}

async function respond(tool: string, run: Promise<ToolResult>) {
  const r = await run;
  // Never log the bearer or the payload.
  console.log(JSON.stringify({ lane: "mcp", tool, is_error: r.isError }));
  return toCallToolResult(r);
}

export class TocsinMcp extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "tocsin", version: pkg.version });

  async init() {
    const api = () => new TocsinApi(this.env.TOCSIN_BASE_URL || DEFAULT_BASE_URL);

    this.server.registerTool(
      "tocsin_latest",
      {
        description: "The newest security advisories, newest first. Filter by ecosystem, minimum severity or exploited.",
        inputSchema: latestInput,
      },
      (args) => respond("tocsin_latest", latest(api(), args)),
    );
    this.server.registerTool(
      "tocsin_check",
      {
        description: "Check a lockfile and/or runtime versions against known advisories. Answers the affected dependencies and what to do.",
        inputSchema: checkInput,
      },
      (args) => respond("tocsin_check", check(api(), args)),
    );
    this.server.registerTool(
      "tocsin_get",
      {
        description: "One advisory by Tocsin id or CVE id (CVE-YYYY-NNNN).",
        inputSchema: getInput,
      },
      (args) => respond("tocsin_get", get(api(), args)),
    );
    this.server.registerTool(
      "tocsin_watchlist_events",
      {
        description: "New events on one of your watch lists. Needs Authorization: Bearer <API key> on the MCP connection.",
        inputSchema: watchlistInput,
      },
      (args) => respond("tocsin_watchlist_events", watchlistEvents(api(), args, this.props?.bearer ?? null)),
    );
  }
}

const mcp = TocsinMcp.serve("/mcp");

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // The agents SDK binds these props to the session when it starts
      // (the initialize request), so the key on that request is the one used.
      const props: Props = { bearer: parseBearer(request.headers.get("Authorization")) };
      (ctx as ExecutionContext & { props: Props }).props = props;
      return mcp.fetch(request, env, ctx);
    }
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({ name: "tocsin", mcp: "/mcp", docs: "https://tocsin.sh/llms.txt" });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
