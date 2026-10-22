export interface Env {
  DB: D1Database;
  CURSORS: KVNamespace;
  DELIVERIES: Queue;
}
