export interface Env {
  DB: D1Database;
  CURSORS: KVNamespace;
  DELIVERIES: Queue;
  // Optional. Raises the GitHub API limit for the php-runtime, python-runtime,
  // deno-runtime and bun-runtime ingesters.
  GITHUB_TOKEN?: string;
  // NVD API key (wrangler secret). Unset: the NVD ingester runs at the keyless limit.
  NVD_API_KEY?: string;
}
