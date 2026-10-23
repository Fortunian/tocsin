import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, newKey } from "./keys-helpers.tcs-8";

const URL_OK = "https://hooks.example.test/x";

async function row(id: string) {
  return env.DB.prepare("SELECT delivery, webhook_url, webhook_secret FROM watchlists WHERE id = ?")
    .bind(id)
    .first<{ delivery: string; webhook_url: string | null; webhook_secret: string | null }>();
}

async function createPoll(key: string): Promise<string> {
  const res = await call("POST", "/v1/watchlists", { key, body: { name: "poll list" } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("webhook delivery and the plans.webhooks gate", () => {
  it("a free key can create a webhook list: 201 with the secret once, and the list route never shows it", async () => {
    const { key } = await newKey();
    const res = await call("POST", "/v1/watchlists", { key, body: { name: "hooks", delivery: "webhook", webhook_url: URL_OK } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; delivery: string; webhook_url: string; webhook_secret: string };
    expect(body.delivery).toBe("webhook");
    expect(body.webhook_url).toBe(URL_OK);
    expect(body.webhook_secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(await row(body.id)).toEqual({ delivery: "webhook", webhook_url: URL_OK, webhook_secret: body.webhook_secret });

    const list = await call("GET", "/v1/watchlists", { key });
    const text = await list.text();
    expect(text).not.toContain("webhook_secret");
    expect(text).not.toContain(body.webhook_secret);
    const parsed = JSON.parse(text) as { watchlists: Array<{ id: string; delivery: string; webhook_url: string | null }> };
    expect(parsed.watchlists.find((w) => w.id === body.id)).toMatchObject({ delivery: "webhook", webhook_url: URL_OK });
  });

  it("a free key can PATCH a poll list to webhook (200 with a new secret) and back to poll (URL and secret cleared)", async () => {
    const { key } = await newKey();
    const id = await createPoll(key);

    const on = await call("PATCH", `/v1/watchlists/${id}`, { key, body: { delivery: "webhook", webhook_url: URL_OK } });
    expect(on.status).toBe(200);
    const onBody = (await on.json()) as { id: string; delivery: string; webhook_secret: string };
    expect(onBody).toMatchObject({ id, delivery: "webhook" });
    expect(onBody.webhook_secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(await row(id)).toEqual({ delivery: "webhook", webhook_url: URL_OK, webhook_secret: onBody.webhook_secret });

    const off = await call("PATCH", `/v1/watchlists/${id}`, { key, body: { delivery: "poll" } });
    expect(off.status).toBe(200);
    expect(await off.json()).not.toHaveProperty("webhook_secret");
    expect(await row(id)).toEqual({ delivery: "poll", webhook_url: null, webhook_secret: null });
  });

  it("after UPDATE plans SET webhooks=0 the same POST and PATCH answer 403 and the row is unchanged", async () => {
    const { key } = await newKey();
    const id = await createPoll(key);
    await env.DB.prepare("UPDATE plans SET webhooks = 0 WHERE id = 'free'").run();
    try {
      const post = await call("POST", "/v1/watchlists", { key, body: { name: "hooks", delivery: "webhook", webhook_url: URL_OK } });
      expect(post.status).toBe(403);
      expect(await post.json()).toEqual({ error: "webhooks not enabled for this plan" });

      const patch = await call("PATCH", `/v1/watchlists/${id}`, { key, body: { delivery: "webhook", webhook_url: URL_OK } });
      expect(patch.status).toBe(403);
      expect(await row(id)).toEqual({ delivery: "poll", webhook_url: null, webhook_secret: null });

      const lists = (await (await call("GET", "/v1/watchlists", { key })).json()) as { watchlists: unknown[] };
      expect(lists.watchlists).toHaveLength(1);

      // A poll list is still free to create while the gate is shut.
      expect((await call("POST", "/v1/watchlists", { key, body: { name: "p2" } })).status).toBe(201);
    } finally {
      await env.DB.prepare("UPDATE plans SET webhooks = 1 WHERE id = 'free'").run();
    }
  });

  it("rejects bad delivery input with 400", async () => {
    const { key } = await newKey();
    const bad = [
      { name: "a", delivery: "webhook", webhook_url: "http://hooks.example.test/x" },
      { name: "a", delivery: "email" },
      { name: "a", delivery: "Webhook", webhook_url: URL_OK },
      { name: "a", delivery: "webhook" },
      { name: "a", delivery: "webhook", webhook_url: "https://user:pw@hooks.example.test/x" },
      { name: "a", delivery: "webhook", webhook_url: "not a url" },
      { name: "a", delivery: "webhook", webhook_url: `https://hooks.example.test/${"x".repeat(2100)}` },
      { name: "a", webhook_url: URL_OK },
    ];
    for (const body of bad) {
      const res = await call("POST", "/v1/watchlists", { key, body });
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const id = await createPoll(key);
    expect((await call("PATCH", `/v1/watchlists/${id}`, { key, body: { delivery: "email" } })).status).toBe(400);
    expect(await row(id)).toEqual({ delivery: "poll", webhook_url: null, webhook_secret: null });
  });

  it("PATCH on another key's list answers 404 and changes nothing", async () => {
    const owner = await newKey();
    const other = await newKey();
    const id = await createPoll(owner.key);
    const res = await call("PATCH", `/v1/watchlists/${id}`, { key: other.key, body: { delivery: "webhook", webhook_url: URL_OK } });
    expect(res.status).toBe(404);
    expect(await row(id)).toEqual({ delivery: "poll", webhook_url: null, webhook_secret: null });
  });
});
