import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, newKey } from "./keys-helpers.tcs-8";
import { idFor, seed, type SeedRow } from "./seed.tcs-3";

// Each test reserves its own cursor range above every earlier one, and makes
// its list before it seeds, so a new list (which starts at the newest feed
// cursor) sees exactly the rows the test seeds after it.
let nextCursor = 5_000_000;
function cursors(n: number): number {
  const base = nextCursor;
  nextCursor += n + 10;
  return base;
}

interface Watchlist {
  id: string;
  name: string;
  filter: Record<string, unknown>;
  cursor: number;
  delivery: string;
  created_at: string;
}
interface Page {
  events: { id: string; ecosystem: string; component: string }[];
  next_cursor: number;
  has_more: boolean;
}

async function create(key: string, body: Record<string, unknown>): Promise<Response> {
  return call("POST", "/v1/watchlists", { key, body });
}

async function createOk(key: string, body: Record<string, unknown>): Promise<Watchlist> {
  const res = await create(key, body);
  if (res.status !== 201) throw new Error(`create answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as Watchlist;
}

async function poll(key: string, id: string, query = ""): Promise<{ status: number; body: Page }> {
  const res = await call("GET", `/v1/watchlists/${id}/events${query}`, { key });
  return { status: res.status, body: (await res.json()) as Page };
}

async function storedCursor(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT cursor FROM watchlists WHERE id = ?").bind(id).first<{ cursor: number }>();
  if (!row) throw new Error(`no watch list ${id}`);
  return row.cursor;
}

function components(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `pkg-fixture-${i}`);
}

describe("POST /v1/watchlists limits", () => {
  it("lets a free key create 25 lists and answers 403 with max_watchlists: 25 on the 26th", async () => {
    const { key, key_id } = await newKey();
    for (let i = 0; i < 25; i++) {
      const res = await create(key, { name: `list ${i}` });
      expect(res.status, `create ${i}`).toBe(201);
    }
    const res = await create(key, { name: "list 26" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.max_watchlists).toBe(25);
    expect(body.error).toMatch(/watch list limit/);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE key_id = ?").bind(key_id).first<{ n: number }>();
    expect(n?.n).toBe(25);
  });

  it("answers 403 with max_components: 2000 for 2001 components, and 201 for 2000", async () => {
    const { key } = await newKey();
    const over = await create(key, { name: "too many", components: components(2001) });
    expect(over.status).toBe(403);
    const body = (await over.json()) as Record<string, unknown>;
    expect(body.max_components).toBe(2000);
    expect(body.error).toMatch(/component limit/);

    const at = await create(key, { name: "at cap", components: components(2000) });
    expect(at.status).toBe(201);
    expect(((await at.json()) as Watchlist).filter.components).toHaveLength(2000);
  });

  it("reads the limits from the key's plans row, not from a constant", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO plans (id, max_watchlists, webhooks, max_components) VALUES ('tcs8test', 2, 0, 3)").run();
    const { key, key_id } = await newKey();
    await env.DB.prepare("UPDATE api_keys SET plan = 'tcs8test' WHERE id = ?").bind(key_id).run();

    expect((await create(key, { name: "a" })).status).toBe(201);
    expect((await create(key, { name: "b" })).status).toBe(201);
    const third = await create(key, { name: "c" });
    expect(third.status).toBe(403);
    expect(((await third.json()) as Record<string, unknown>).max_watchlists).toBe(2);

    await env.DB.prepare("DELETE FROM watchlists WHERE key_id = ?").bind(key_id).run();
    const comps = await create(key, { name: "d", components: components(4) });
    expect(comps.status).toBe(403);
    expect(((await comps.json()) as Record<string, unknown>).max_components).toBe(3);
  });

  it("does not pass the cap when creates run in parallel", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO plans (id, max_watchlists, webhooks, max_components) VALUES ('tcs8par', 3, 0, 10)").run();
    const { key, key_id } = await newKey();
    await env.DB.prepare("UPDATE api_keys SET plan = 'tcs8par' WHERE id = ?").bind(key_id).run();
    const statuses = (await Promise.all(Array.from({ length: 8 }, (_, i) => create(key, { name: `p${i}` })))).map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 403)).toHaveLength(5);
  });

  it("answers 400 for a body with a missing name or wrong types", async () => {
    const { key } = await newKey();
    for (const body of [
      {},
      { name: "" },
      { name: 3 },
      { name: "x", ecosystems: "node" },
      { name: "x", components: [1] },
      { name: "x", runtimes: ["node"] },
      { name: "x", runtimes: { node: 24 } },
      { name: "x", min_severity: "severe" },
      { name: "x", exploited_only: "yes" },
    ]) {
      expect((await create(key, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("POST", "/v1/watchlists", { key, rawBody: "{" })).status).toBe(400);
  });

  it("answers 413 for a body over watchlists.max_body_bytes", async () => {
    await env.DB.prepare("UPDATE settings SET value = '200' WHERE key = 'watchlists.max_body_bytes'").run();
    try {
      const { key } = await newKey();
      const res = await create(key, { name: "big", components: components(50) });
      expect(res.status).toBe(413);
    } finally {
      await env.DB.prepare("UPDATE settings SET value = '1048576' WHERE key = 'watchlists.max_body_bytes'").run();
    }
  });
});

describe("GET and DELETE /v1/watchlists", () => {
  it("lists the key's lists as poll lists with no webhook secret, and deletes one (204, then 404)", async () => {
    const { key } = await newKey();
    const a = await createOk(key, { name: "alpha", ecosystems: ["npm", " npm ", ""], min_severity: "high", exploited_only: true, runtimes: { node: "24.0.0" } });
    const b = await createOk(key, { name: "beta" });
    expect(a.delivery).toBe("poll");
    expect(a.filter).toEqual({ ecosystems: ["npm"], components: [], runtimes: { node: "24.0.0" }, min_severity: "high", exploited_only: true });
    const row = await env.DB.prepare("SELECT delivery, webhook_url, webhook_secret FROM watchlists WHERE id = ?").bind(a.id).first();
    expect(row).toEqual({ delivery: "poll", webhook_url: null, webhook_secret: null });

    const res = await call("GET", "/v1/watchlists", { key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { watchlists: Record<string, unknown>[] };
    expect(body.watchlists.map((w) => w.id)).toEqual([a.id, b.id]);
    for (const w of body.watchlists) {
      expect(w).not.toHaveProperty("webhook_secret");
      expect(w).not.toHaveProperty("filter_json");
    }
    expect(body.watchlists[0].filter).toEqual(a.filter);

    const del = await call("DELETE", `/v1/watchlists/${a.id}`, { key });
    expect(del.status).toBe(204);
    expect((await call("DELETE", `/v1/watchlists/${a.id}`, { key })).status).toBe(404);
    const after = (await (await call("GET", "/v1/watchlists", { key })).json()) as { watchlists: { id: string }[] };
    expect(after.watchlists.map((w) => w.id)).toEqual([b.id]);
  });
});

describe("GET /v1/watchlists/:id/events", () => {
  it("returns only node events for an ecosystem=node list, advances the stored cursor, and repeats nothing", async () => {
    const { key } = await newKey();
    const list = await createOk(key, { name: "node only", ecosystems: ["node"] });
    const c = cursors(6);
    expect(c).toBeGreaterThan(list.cursor);
    const rows: SeedRow[] = [
      { id: idFor("W8N", 0), cursor: c, ecosystem: "node", component: "node" },
      { id: idFor("W8N", 1), cursor: c + 1, ecosystem: "npm", component: "left-pad" },
      { id: idFor("W8N", 2), cursor: c + 2, ecosystem: "php", component: "php" },
      { id: idFor("W8N", 3), cursor: c + 3, ecosystem: "node", component: "node" },
      { id: idFor("W8N", 4), cursor: c + 4, ecosystem: "npm", component: "node" },
    ];
    await seed(rows);

    const first = await poll(key, list.id);
    expect(first.status).toBe(200);
    expect(first.body.events.map((e) => e.id)).toEqual([rows[0].id, rows[3].id]);
    for (const e of first.body.events) expect(e.ecosystem).toBe("node");
    expect(first.body.next_cursor).toBe(c + 3);
    expect(first.body.has_more).toBe(false);
    expect(await storedCursor(list.id)).toBe(c + 3);

    const second = await poll(key, list.id);
    expect(second.status).toBe(200);
    expect(second.body.events).toEqual([]);
    expect(second.body.next_cursor).toBe(c + 3);
    expect(await storedCursor(list.id)).toBe(c + 3);
  });

  it("peek=true returns the events and leaves the stored cursor; peek=false advances it", async () => {
    const { key } = await newKey();
    const list = await createOk(key, { name: "peek", ecosystems: ["node"] });
    const start = await storedCursor(list.id);
    const c = cursors(2);
    await seed([{ id: idFor("W8P", 0), cursor: c, ecosystem: "node" }]);

    const peek = await poll(key, list.id, "?peek=true");
    expect(peek.status).toBe(200);
    expect(peek.body.events.map((e) => e.id)).toEqual([idFor("W8P", 0)]);
    expect(peek.body.next_cursor).toBe(c);
    expect(await storedCursor(list.id)).toBe(start);

    const again = await poll(key, list.id, "?peek=true");
    expect(again.body.events).toHaveLength(1);

    const real = await poll(key, list.id, "?peek=false");
    expect(real.body.events).toHaveLength(1);
    expect(await storedCursor(list.id)).toBe(c);
    expect((await poll(key, list.id, "?peek=yes")).status).toBe(400);
  });

  it("limit=1 answers has_more: true and moves the cursor by one event", async () => {
    const { key } = await newKey();
    const list = await createOk(key, { name: "paged", ecosystems: ["node"] });
    const c = cursors(3);
    await seed([
      { id: idFor("W8M", 0), cursor: c, ecosystem: "node" },
      { id: idFor("W8M", 1), cursor: c + 1, ecosystem: "node" },
    ]);
    const p1 = await poll(key, list.id, "?limit=1");
    expect(p1.body.events.map((e) => e.id)).toEqual([idFor("W8M", 0)]);
    expect(p1.body.has_more).toBe(true);
    expect(await storedCursor(list.id)).toBe(c);
    const p2 = await poll(key, list.id, "?limit=1");
    expect(p2.body.events.map((e) => e.id)).toEqual([idFor("W8M", 1)]);
    expect(p2.body.has_more).toBe(false);
    for (const q of ["?limit=0", "?limit=101", "?limit=abc"]) expect((await poll(key, list.id, q)).status, q).toBe(400);
  });

  it("matches a components list of 2000 entries, min_severity, exploited_only and runtimes", async () => {
    const { key } = await newKey();
    const comps = components(2000);
    const byComp = await createOk(key, { name: "comps", components: comps });
    const bySev = await createOk(key, { name: "sev", ecosystems: ["php"], min_severity: "high" });
    const byExp = await createOk(key, { name: "exp", ecosystems: ["PyPI"], exploited_only: true });
    const byRuntime = await createOk(key, { name: "rt", runtimes: { node: "24.0.0" } });
    const c = cursors(10);
    await seed([
      { id: idFor("W8C", 0), cursor: c, ecosystem: "npm", component: "pkg-fixture-1999" },
      { id: idFor("W8C", 1), cursor: c + 1, ecosystem: "npm", component: "other-pkg" },
      { id: idFor("W8C", 2), cursor: c + 2, ecosystem: "php", component: "php", label: "medium" },
      { id: idFor("W8C", 3), cursor: c + 3, ecosystem: "php", component: "php", label: "critical" },
      { id: idFor("W8C", 4), cursor: c + 4, ecosystem: "PyPI", component: "django", exploited: false },
      { id: idFor("W8C", 5), cursor: c + 5, ecosystem: "PyPI", component: "flask", exploited: true },
      { id: idFor("W8C", 6), cursor: c + 6, ecosystem: "node", component: "node" },
    ]);
    expect((await poll(key, byComp.id)).body.events.map((e) => e.id)).toEqual([idFor("W8C", 0)]);
    expect((await poll(key, bySev.id)).body.events.map((e) => e.id)).toEqual([idFor("W8C", 3)]);
    expect((await poll(key, byExp.id)).body.events.map((e) => e.id)).toEqual([idFor("W8C", 5)]);
    expect((await poll(key, byRuntime.id)).body.events.map((e) => e.id)).toEqual([idFor("W8C", 6)]);
  });

  it("starts a new list at the newest feed cursor, so older events are not returned", async () => {
    const { key } = await newKey();
    const c = cursors(2);
    await seed([{ id: idFor("W8S", 0), cursor: c, ecosystem: "node" }]);
    const list = await createOk(key, { name: "fresh", ecosystems: ["node"] });
    expect(list.cursor).toBe(c);
    expect((await poll(key, list.id)).body.events).toEqual([]);
  });
});
