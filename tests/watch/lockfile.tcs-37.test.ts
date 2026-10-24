import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runKeyRetention } from "../../src/cron/retention";
import {
  FakeQueue,
  alignMatchCursor,
  call,
  cron,
  deliveriesOf,
  depCount,
  seedAdvisory,
  seedKey,
  seedList,
  seedPlan,
  storedDeps,
  uid,
  upload,
  type Dep,
} from "./helpers.tcs-37";

// TCS-37 acceptance: POST /v1/watchlists/:id/lockfile through the production
// entry (src/index.ts), and the dependency match pass through runCron. Every
// test makes its own key, list and package names.

interface UploadAnswer {
  watchlist_id: string;
  dependencies: number;
  checked: number;
  affected: Array<{ dependency: Dep; advisory_id: string; fixed_in: string | null }>;
  skipped: Array<Record<string, unknown>>;
  feed_cursor: number;
}

// Three npm packages with names no other test uses. `vuln` is at 1.2.3.
function threeDeps(): { deps: Dep[]; vuln: string; safe: string; other: string } {
  const tag = uid("p").slice(2, 14).toLowerCase();
  const vuln = `fx37-vuln-${tag}`;
  const safe = `fx37-safe-${tag}`;
  const other = `fx37-other-${tag}`;
  return {
    vuln,
    safe,
    other,
    deps: [
      { ecosystem: "npm", name: vuln, version: "1.2.3" },
      { ecosystem: "npm", name: safe, version: "2.0.0" },
      { ecosystem: "npm", name: other, version: "3.1.0" },
    ],
  };
}

function lockfileText(deps: Dep[]): string {
  const packages: Record<string, unknown> = { "": { name: "fx37", version: "1.0.0" } };
  for (const d of deps) packages[`node_modules/${d.name}`] = { version: d.version };
  return JSON.stringify({ name: "fx37", version: "1.0.0", lockfileVersion: 3, requires: true, packages });
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("upload", () => {
  it("a JSON body with 3 dependencies stores 3 rows and answers 1 affected", async () => {
    const { deps, vuln, safe } = threeDeps();
    const adv = await seedAdvisory({ component: vuln, affected: [{ introduced: "0", fixed: "1.2.4" }] });
    // Same package as `safe`, but 2.0.0 is outside the range: not affected.
    await seedAdvisory({ component: safe, affected: [{ introduced: "0", fixed: "1.9.0" }] });
    const key = await seedKey();
    const list = await seedList(key.id);

    const res = await upload(key.token, list, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadAnswer;
    expect(body.watchlist_id).toBe(list);
    expect(body.dependencies).toBe(3);
    expect(body.checked).toBe(3);
    expect(body.affected).toHaveLength(1);
    expect(body.affected[0].advisory_id).toBe(adv.id);
    expect(body.affected[0].dependency).toEqual(deps[0]);
    expect(body.affected[0].fixed_in).toBe("1.2.4");
    expect(await depCount(list)).toBe(3);
    expect(await storedDeps(list)).toEqual(
      [...deps].sort((a, b) => (a.name < b.name ? -1 : 1)).map((d) => ({ dep_ecosystem: d.ecosystem, dep_name: d.name, version: d.version })),
    );
  });

  it("the same 3 dependencies as a multipart package-lock.json store 3 rows", async () => {
    const { deps } = threeDeps();
    const key = await seedKey();
    const list = await seedList(key.id);
    const form = new FormData();
    form.append("package-lock.json", new Blob([lockfileText(deps)], { type: "application/json" }), "package-lock.json");

    const res = await call("POST", `/v1/watchlists/${list}/lockfile`, { token: key.token, form });
    expect(res.status).toBe(200);
    expect(((await res.json()) as UploadAnswer).dependencies).toBe(3);
    expect(await depCount(list)).toBe(3);
  });

  it("a re-upload replaces the set", async () => {
    const { deps } = threeDeps();
    const key = await seedKey();
    const list = await seedList(key.id);
    expect((await upload(key.token, list, deps)).status).toBe(200);

    const next = [deps[1], { ecosystem: "npm", name: deps[2].name, version: "3.2.0" }];
    const res = await upload(key.token, list, next);
    expect(res.status).toBe(200);
    expect(((await res.json()) as UploadAnswer).dependencies).toBe(2);
    const rows = await storedDeps(list);
    expect(rows.map((r) => `${r.dep_name}@${r.version}`).sort()).toEqual(next.map((d) => `${d.name}@${d.version}`).sort());
  });

  it("no API key answers 401; another key's list and an unknown list answer 404 and store nothing", async () => {
    const { deps } = threeDeps();
    const owner = await seedKey();
    const intruder = await seedKey();
    const list = await seedList(owner.id);

    expect((await call("POST", `/v1/watchlists/${list}/lockfile`, { json: { dependencies: deps } })).status).toBe(401);
    const res = await upload(intruder.token, list, deps);
    expect(res.status).toBe(404);
    expect(await depCount(list)).toBe(0);
    expect((await upload(intruder.token, uid("wl37"), deps)).status).toBe(404);

    // The intruder's attempt did not change the owner's list either.
    const row = await env.DB.prepare("SELECT dependency_count, dependencies_at FROM watchlists WHERE id = ?").bind(list).first();
    expect(row).toEqual({ dependency_count: 0, dependencies_at: null });
  });

  it("only unsupported-ecosystem dependencies answer 400 and keep the previous set", async () => {
    const { deps } = threeDeps();
    const key = await seedKey();
    const list = await seedList(key.id);
    expect((await upload(key.token, list, deps)).status).toBe(200);

    const res = await upload(key.token, list, [{ ecosystem: "Hackage", name: "aeson", version: "2.0.0" }]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("no dependencies to watch");
    expect(await depCount(list)).toBe(3);
  });

  it("over the plan limit answers 413 with the limit in the body and stores nothing", async () => {
    const { deps } = threeDeps();
    const key = await seedKey(await seedPlan(2));
    const list = await seedList(key.id);

    const res = await upload(key.token, list, deps);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; max_watch_dependencies: number; dependencies: number };
    expect(body.max_watch_dependencies).toBe(2);
    expect(body.dependencies).toBe(3);
    expect(await depCount(list)).toBe(0);

    // At the limit is fine.
    expect((await upload(key.token, list, deps.slice(0, 2))).status).toBe(200);
    expect(await depCount(list)).toBe(2);
  });

  it("a plan row with no max_watch_dependencies fails closed (500) and stores nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = threeDeps();
    const key = await seedKey(await seedPlan(null));
    const list = await seedList(key.id);
    expect((await upload(key.token, list, deps)).status).toBe(500);
    expect(await depCount(list)).toBe(0);
  });

  it("GET /v1/watchlists/:id answers dependencies and dependencies_uploaded_at", async () => {
    const { deps } = threeDeps();
    const key = await seedKey();
    const list = await seedList(key.id);
    const before = (await (await call("GET", `/v1/watchlists/${list}`, { token: key.token })).json()) as Record<string, unknown>;
    expect(before.dependencies).toBe(0);
    expect(before.dependencies_uploaded_at).toBeNull();

    expect((await upload(key.token, list, deps)).status).toBe(200);
    const after = (await (await call("GET", `/v1/watchlists/${list}`, { token: key.token })).json()) as Record<string, unknown>;
    expect(after.dependencies).toBe(3);
    expect(typeof after.dependencies_uploaded_at).toBe("string");
    expect(Number.isNaN(Date.parse(after.dependencies_uploaded_at as string))).toBe(false);
  });
});

describe("delivery", () => {
  it("a new matching advisory gives exactly 1 deliveries row and 1 message; a second cron run gives none", async () => {
    const { deps, vuln } = threeDeps();
    const key = await seedKey();
    const list = await seedList(key.id);
    expect((await upload(key.token, list, deps)).status).toBe(200);
    await alignMatchCursor();

    const adv = await seedAdvisory({ component: vuln, affected: [{ introduced: "1.0.0", fixed: "1.5.0" }] });
    const q = new FakeQueue();
    await cron(q);

    const rows = await deliveriesOf(list);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ advisory_id: adv.id, cursor: adv.cursor, status: "pending" });
    const affected = JSON.parse(rows[0].affected_json ?? "null") as Array<{ dependency: Dep; fixed_in: string }>;
    expect(affected).toHaveLength(1);
    expect(affected[0].dependency).toEqual(deps[0]);
    expect(affected[0].fixed_in).toBe("1.5.0");
    expect(q.forList(list).map((m) => m.body)).toEqual([{ watchlist_id: list, advisory_id: adv.id }]);

    const q2 = new FakeQueue();
    await cron(q2);
    expect(await deliveriesOf(list)).toHaveLength(1);
    expect(q2.forList(list)).toHaveLength(0);
  });

  it("a re-upload with the dependency removed gives no delivery for a new advisory on it", async () => {
    const { deps, vuln } = threeDeps();
    const key = await seedKey();
    const list = await seedList(key.id);
    expect((await upload(key.token, list, deps)).status).toBe(200);
    expect((await upload(key.token, list, deps.slice(1))).status).toBe(200);
    await alignMatchCursor();

    await seedAdvisory({ component: vuln, affected: [{ introduced: "0", fixed: "9.0.0" }] });
    const q = new FakeQueue();
    await cron(q);
    expect(await deliveriesOf(list)).toHaveLength(0);
    expect(q.forList(list)).toHaveLength(0);
  });

  it("a re-upload of the same set after a delivered row sends nothing again", async () => {
    const { deps, vuln } = threeDeps();
    const key = await seedKey();
    const list = await seedList(key.id);
    expect((await upload(key.token, list, deps)).status).toBe(200);
    await alignMatchCursor();
    const adv = await seedAdvisory({ component: vuln, affected: [{ introduced: "0", fixed: "9.0.0" }] });
    await cron(new FakeQueue());
    await env.DB.prepare("UPDATE deliveries SET status = 'delivered', delivered_at = ? WHERE watchlist_id = ? AND advisory_id = ?")
      .bind(new Date().toISOString(), list, adv.id)
      .run();

    expect((await upload(key.token, list, deps)).status).toBe(200);
    const q = new FakeQueue();
    await cron(q);
    expect(q.forList(list)).toHaveLength(0);
    const rows = await deliveriesOf(list);
    expect(rows.map((r) => [r.advisory_id, r.status])).toEqual([[adv.id, "delivered"]]);
  });

  it("an advisory on the same package outside the version range gives no delivery", async () => {
    const { deps, vuln } = threeDeps();
    const key = await seedKey();
    const list = await seedList(key.id);
    expect((await upload(key.token, list, deps)).status).toBe(200);
    await alignMatchCursor();

    await seedAdvisory({ component: vuln, affected: [{ introduced: "0", fixed: "1.2.3" }] });
    const q = new FakeQueue();
    await cron(q);
    expect(await deliveriesOf(list)).toHaveLength(0);
    expect(q.forList(list)).toHaveLength(0);
  });
});

describe("retention", () => {
  it("DELETE /v1/watchlists/:id deletes the list's dependency rows", async () => {
    const { deps } = threeDeps();
    const key = await seedKey();
    const list = await seedList(key.id);
    expect((await upload(key.token, list, deps)).status).toBe(200);
    expect(await depCount(list)).toBe(3);

    expect((await call("DELETE", `/v1/watchlists/${list}`, { token: key.token })).status).toBe(204);
    expect(await depCount(list)).toBe(0);
  });

  it("another key's DELETE leaves the dependency rows", async () => {
    const { deps } = threeDeps();
    const key = await seedKey();
    const intruder = await seedKey();
    const list = await seedList(key.id);
    expect((await upload(key.token, list, deps)).status).toBe(200);
    expect((await call("DELETE", `/v1/watchlists/${list}`, { token: intruder.token })).status).toBe(404);
    expect(await depCount(list)).toBe(3);
  });

  it("the monthly key retention deletes the dependency rows of a stale key's lists", async () => {
    const { deps } = threeDeps();
    const key = await seedKey();
    const keep = await seedKey();
    const list = await seedList(key.id);
    const kept = await seedList(keep.id);
    expect((await upload(key.token, list, deps)).status).toBe(200);
    expect((await upload(keep.token, kept, deps)).status).toBe(200);
    // The stale key was last used long before any other key in this D1.
    await env.DB.prepare("UPDATE api_keys SET last_used_at = '2001-01-01T00:00:00.000Z' WHERE id = ?").bind(key.id).run();

    await runKeyRetention(env, new Date());
    expect(await depCount(list)).toBe(0);
    expect(await depCount(kept)).toBe(3);
  });
});
