export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  // The Tocsin API this server reads. Default https://tocsin.sh (wrangler.toml [vars]).
  TOCSIN_BASE_URL?: string;
}

// Per-session props, set from the request that opens the MCP session.
export type Props = { bearer: string | null };
