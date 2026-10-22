export interface Env {
  DB: D1Database;
  CURSORS: KVNamespace;
  DELIVERIES: Queue;
  // Optional. Raises the GitHub API limit for the php-runtime ingester.
  GITHUB_TOKEN?: string;
}
