import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, nextIp, sha256HexOf, uniqueEmail } from "./keys-helpers.tcs-8";

async function rowsFor(email: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM api_keys WHERE email = ?").bind(email).all<Record<string, unknown>>();
  return results;
}

describe("POST /v1/keys", () => {
  it("issues a tcs_ key once, answers the plaintext once, and stores only its sha256", async () => {
    const email = uniqueEmail("once");
    const res = await call("POST", "/v1/keys", { body: { email } });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { key: string; key_id: string; plan: string; email: string };
    expect(body.key).toMatch(/^tcs_[0-9a-f]{64}$/);
    expect(body.plan).toBe("free");
    expect(body.email).toBe(email);

    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(body.key_id);
    expect(rows[0].key_hash).toBe(await sha256HexOf(body.key));
    expect(rows[0].plan).toBe("free");
    for (const v of Object.values(rows[0])) expect(v).not.toBe(body.key);
  });

  it("answers 409 with no key on a second call for the same email, also with other case and spaces", async () => {
    const email = uniqueEmail("twice");
    expect((await call("POST", "/v1/keys", { body: { email } })).status).toBe(201);
    const before = await rowsFor(email);

    for (const variant of [email, `  ${email.toUpperCase()}  `]) {
      const res = await call("POST", "/v1/keys", { body: { email: variant } });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.key).toBeUndefined();
      expect(body.error).toMatch(/already exists/);
    }
    const after = await rowsFor(email);
    expect(after).toHaveLength(1);
    expect(after[0].key_hash).toBe(before[0].key_hash);
  });

  it("stores a mixed-case email normalized, so the lower-case form is the same identity", async () => {
    const lower = uniqueEmail("case");
    const res = await call("POST", "/v1/keys", { body: { email: ` ${lower.toUpperCase()} ` } });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { email: string }).email).toBe(lower);
    expect(await rowsFor(lower)).toHaveLength(1);
    expect((await call("POST", "/v1/keys", { body: { email: lower } })).status).toBe(409);
  });

  it("answers 400 for a body that is not an email address, and 400 for a body that is not JSON", async () => {
    for (const body of [{}, { email: "" }, { email: "not-an-email" }, { email: 42 }, { email: "a@b" }, []]) {
      const res = await call("POST", "/v1/keys", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const res = await call("POST", "/v1/keys", { rawBody: "{not json" });
    expect(res.status).toBe(400);
  });

  it("limits key requests per IP from the settings row keys.anon_rate_per_minute", async () => {
    // The window is one clock minute, so the clock is pinned: the burst never crosses a boundary.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 1, 0, 15));
    await env.DB.prepare("UPDATE settings SET value = '2' WHERE key = 'keys.anon_rate_per_minute'").run();
    try {
      const ip = nextIp();
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await call("POST", "/v1/keys", { ip, body: { email: uniqueEmail("rl") } })).status);
      expect(statuses).toEqual([201, 201, 429]);
    } finally {
      vi.useRealTimers();
      await env.DB.prepare("UPDATE settings SET value = '5' WHERE key = 'keys.anon_rate_per_minute'").run();
    }
  });
});
