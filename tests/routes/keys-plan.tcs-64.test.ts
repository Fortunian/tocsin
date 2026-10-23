import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { CONFIRM_CREATE_SQL, CONFIRM_ROTATE_SQL, KEY_HASH_BY_EMAIL_SQL } from "../../src/routes/keys";

// TCS-64: the three api_keys statements of the confirm flow read and write
// through idx_api_keys_email on 5,000 seeded keys.

async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

const BARE_SCAN = /SCAN api_keys(?! USING)/;

beforeAll(async () => {
  const ins = env.DB.prepare(
    "INSERT INTO api_keys (id, key_hash, plan, email, created_at, last_used_at) VALUES (?, ?, 'free', ?, ?, ?)",
  );
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < 5000; i++) {
    stmts.push(ins.bind(`key_plan64_${i}`, `hash-fixture-${i}`, `plan64-${i}@example.test`, "2026-10-23T00:00:00.000Z", "2026-10-23T00:00:00.000Z"));
  }
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE id LIKE 'key_plan64_%'").first<{ n: number }>();
  expect(n?.n).toBe(5000);
});

describe("api_keys statements of the confirm flow", () => {
  it("the send-time lookup by email uses idx_api_keys_email", async () => {
    const p = await plan(KEY_HASH_BY_EMAIL_SQL, "plan64-42@example.test");
    expect(p).toMatch(/SEARCH api_keys USING (COVERING )?INDEX idx_api_keys_email \(email=\?\)/);
    expect(p).not.toMatch(BARE_SCAN);
  });

  it("the rotate compare-and-swap update uses idx_api_keys_email", async () => {
    const p = await plan(CONFIRM_ROTATE_SQL, "hash-new-fixture", "2026-10-23T00:00:00.000Z", "plan64-42@example.test", "hash-fixture-42");
    expect(p).toMatch(/SEARCH api_keys USING (COVERING )?INDEX idx_api_keys_email \(email=\?\)/);
    expect(p).not.toMatch(BARE_SCAN);
  });

  it("the create insert scans nothing and its conflict target is the unique idx_api_keys_email", async () => {
    const p = await plan(CONFIRM_CREATE_SQL, "key_x", "hash-x-fixture", "plan64-new@example.test", "2026-10-23T00:00:00.000Z", "2026-10-23T00:00:00.000Z");
    expect(p).not.toMatch(BARE_SCAN);
    const idx = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_api_keys_email'").first<{ sql: string }>();
    expect(idx?.sql).toMatch(/CREATE UNIQUE INDEX .*idx_api_keys_email ON api_keys \(email\)/);
    expect(CONFIRM_CREATE_SQL).toMatch(/ON CONFLICT\(email\) DO NOTHING/);
  });
});
