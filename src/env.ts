export interface Env {
  DB: D1Database;
  CURSORS: KVNamespace;
  DELIVERIES: Queue;
  // NVD API key (wrangler secret). Unset: the NVD ingester runs at the keyless limit.
  NVD_API_KEY?: string;
}
