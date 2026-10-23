// Test helper (TCS-69): the node-runtime post ledger (node_runtime_posts)
// as a test premise. It replaces the KV cursor premise of the tests that
// came before the ledger: "the cursor is at X" is "every Security Release post
// of the recorded feed published before X has an ok row".
import { env } from "cloudflare:workers";
import { NODE_PARSER_REV, parseNodeFeed } from "../../src/ingest/node-runtime";
import type { PostState } from "../../src/ingest/node-runtime-posts";
import feedXml from "../fixtures/node-runtime/vulnerability.xml?raw";

const AT = "2026-10-01T00:00:00Z";
const INSERT =
  "INSERT INTO node_runtime_posts (url, published, state, attempts, parser_rev, next_check_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(url) DO UPDATE SET published = excluded.published, state = excluded.state, attempts = excluded.attempts, " +
  "parser_rev = excluded.parser_rev, next_check_at = excluded.next_check_at, updated_at = excluded.updated_at";

export const FEED_RELEASES = parseNodeFeed(feedXml).filter((p) => p.title.toLowerCase().includes("security release"));

export async function clearNodeLedger(): Promise<void> {
  await env.DB.prepare("DELETE FROM node_runtime_posts").run();
}

export interface SeedRow {
  url: string;
  published: string;
  state: PostState;
  attempts?: number;
  parser_rev?: string;
  next_check_at?: string | null;
}

export async function seedNodePosts(rows: SeedRow[]): Promise<void> {
  const insert = env.DB.prepare(INSERT);
  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(
      rows.slice(i, i + 50).map((r) => insert.bind(r.url, r.published, r.state, r.attempts ?? 0, r.parser_rev ?? NODE_PARSER_REV, r.next_check_at ?? null, AT)),
    );
  }
}

// An ok row (current parser revision) for every Security Release post of the
// recorded feed published before `beforeIso`.
export async function markNodePostsRead(beforeIso: string, parserRev = NODE_PARSER_REV): Promise<void> {
  await seedNodePosts(FEED_RELEASES.filter((p) => p.published < beforeIso).map((p) => ({ url: p.link, published: p.published, state: "ok", parser_rev: parserRev })));
}

export interface PostStateRow {
  state: PostState;
  published: string;
  attempts: number;
  parser_rev: string;
  next_check_at: string | null;
  last_error: string | null;
}

export async function nodePostRow(url: string): Promise<PostStateRow | null> {
  return env.DB.prepare("SELECT state, published, attempts, parser_rev, next_check_at, last_error FROM node_runtime_posts WHERE url = ?").bind(url).first<PostStateRow>();
}

export async function nodePostState(url: string): Promise<PostState | null> {
  return (await nodePostRow(url))?.state ?? null;
}
