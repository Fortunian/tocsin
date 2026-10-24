import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { WEBHOOK_LISTS_SQL } from "../../src/queue/enqueue";
import { enqueueDependencyMatches, type DependencyMatchResult } from "../../src/queue/dependency-match";
import { runQueue } from "../../src/queue/run";
import {
  DEPENDENCY_DELETE_SQL,
  DEPENDENCY_INSERT_SQL,
  DEPENDENCY_LIST_UPDATE_SQL,
  MATCH_REWIND_SQL,
  dependencyRow,
  filterAccepts,
} from "../../src/watchlists/dependencies";
import type { WatchlistFilter } from "../../src/watchlists/filter";
import { watchlistWhere } from "../../src/watchlists/query";
import { FakeFetch, envWith, fakeBatch, insertDelivery } from "../queue/helpers.tcs-11";
import {
  FakeQueue,
  alignMatchCursor,
  cron,
  deliveriesOf,
  matchCursor,
  recursor,
  seedAdvisory,
  seedKey,
  seedList,
  setMatchCursor,
  topCursor,
  uid,
  upload,
  type Dep,
} from "./helpers.tcs-37";

// TCS-37: the dependency match pass (src/queue/dependency-match.ts), the
// webhook body of a dependency list (src/queue/run.ts) and the negatives of
// plan "System invariants (c)". Each test seeds its own key, list and names.

function tag(): string {
  return uid("t").slice(2, 14).toLowerCase();
}

async function listWith(deps: Dep[], o: Parameters<typeof seedList>[1] = {}): Promise<{ list: string; token: string; feed_cursor: number }> {
  const key = await seedKey();
  const list = await seedList(key.id, o);
  const res = await upload(key.token, list, deps);
  if (res.status !== 200) throw new Error(`upload answered ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { feed_cursor: number };
  return { list, token: key.token, feed_cursor: body.feed_cursor };
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("negatives: no deliveries row", () => {
  it("same name, other ecosystem (npm dependency, PyPI advisory)", async () => {
    const name = `fx37-req-${tag()}`;
    const { list } = await listWith([{ ecosystem: "npm", name, version: "2.0.0" }]);
    await alignMatchCursor();
    await seedAdvisory({ ecosystem: "PyPI", component: name, affected: [{ introduced: "0", fixed: "9.0" }] });
    const q = new FakeQueue();
    await cron(q);
    expect(await deliveriesOf(list)).toHaveLength(0);
    expect(q.forList(list)).toHaveLength(0);
  });

  it("an advisory at or below the list's dependencies_cursor (it was in the upload answer)", async () => {
    const name = `fx37-old-${tag()}`;
    const adv = await seedAdvisory({ component: name, affected: [{ introduced: "0", fixed: "9.0.0" }] });
    const { list, feed_cursor } = await listWith([{ ecosystem: "npm", name, version: "1.0.0" }]);
    expect(feed_cursor).toBeGreaterThanOrEqual(adv.cursor);
    // The lane reads the advisory again (as after a rewind).
    await setMatchCursor(adv.cursor - 1);
    const q = new FakeQueue();
    await cron(q);
    expect(await deliveriesOf(list)).toHaveLength(0);
    expect(q.forList(list)).toHaveLength(0);
  });

  it("a poll list with the same dependency", async () => {
    const name = `fx37-poll-${tag()}`;
    const { list } = await listWith([{ ecosystem: "npm", name, version: "1.0.0" }], { delivery: "poll" });
    await alignMatchCursor();
    await seedAdvisory({ component: name, affected: [{ introduced: "0", fixed: "9.0.0" }] });
    const q = new FakeQueue();
    await cron(q);
    expect(await deliveriesOf(list)).toHaveLength(0);
    expect(q.forList(list)).toHaveLength(0);
  });

  it("a filter with min_severity high and a medium advisory (a high one is delivered)", async () => {
    const name = `fx37-sev-${tag()}`;
    const { list } = await listWith([{ ecosystem: "npm", name, version: "1.0.0" }], { filter: { min_severity: "high" } });
    await alignMatchCursor();
    await seedAdvisory({ component: name, label: "medium", affected: [{ introduced: "0", fixed: "9.0.0" }] });
    const high = await seedAdvisory({ component: name, label: "high", affected: [{ introduced: "0", fixed: "9.0.0" }] });
    const q = new FakeQueue();
    await cron(q);
    expect((await deliveriesOf(list)).map((r) => r.advisory_id)).toEqual([high.id]);
    expect(q.forList(list)).toHaveLength(1);
  });

  it("a changed advisory (new cursor) whose pair already has a delivered row", async () => {
    const name = `fx37-chg-${tag()}`;
    const { list } = await listWith([{ ecosystem: "npm", name, version: "1.0.0" }]);
    await alignMatchCursor();
    const adv = await seedAdvisory({ component: name, affected: [{ introduced: "0", fixed: "9.0.0" }] });
    await cron(new FakeQueue());
    await env.DB.prepare("UPDATE deliveries SET status = 'delivered', delivered_at = ? WHERE watchlist_id = ? AND advisory_id = ?")
      .bind(new Date().toISOString(), list, adv.id)
      .run();

    await recursor(adv.id);
    // A new advisory in the same window still goes out: the old pair is ignored, not an error.
    const fresh = await seedAdvisory({ component: name, affected: [{ introduced: "0", fixed: "9.0.0" }] });
    const q = new FakeQueue();
    await cron(q);
    expect(q.forList(list).map((m) => m.body.advisory_id)).toEqual([fresh.id]);
    const rows = await deliveriesOf(list);
    expect(rows.map((r) => [r.advisory_id, r.status])).toEqual([
      [adv.id, "delivered"],
      [fresh.id, "pending"],
    ]);
  });

  it("PyPI: a stored Django-style name matches its PEP 503 form; a longer name does not", async () => {
    const t = tag();
    const advName = `fx37-django-${t}`;
    const { list: hit } = await listWith([{ ecosystem: "PyPI", name: `Fx37.Django_${t}`, version: "1.0" }]);
    const { list: miss } = await listWith([{ ecosystem: "PyPI", name: `${advName}-foo`, version: "1.0" }]);
    await alignMatchCursor();
    const adv = await seedAdvisory({ ecosystem: "PyPI", component: advName, affected: [{ introduced: "0", fixed: "2.0" }] });
    const q = new FakeQueue();
    await cron(q);
    expect((await deliveriesOf(hit)).map((r) => r.advisory_id)).toEqual([adv.id]);
    expect(await deliveriesOf(miss)).toHaveLength(0);
    expect(q.forList(hit)).toHaveLength(1);
    expect(q.forList(miss)).toHaveLength(0);
  });

  it("an empty-filter dependency list gets only matched advisories; an empty-filter filter list still gets the filter enqueue", async () => {
    const name = `fx37-dep-${tag()}`;
    const { list: depList } = await listWith([{ ecosystem: "npm", name, version: "1.0.0" }]);
    const filterKey = await seedKey();
    const filterList = await seedList(filterKey.id);
    // The filter list starts at the newest cursor, as a list made by POST does.
    await env.DB.prepare("UPDATE watchlists SET cursor = ? WHERE id = ?").bind(await topCursor(), filterList).run();
    await alignMatchCursor();

    const unrelated = await seedAdvisory({ component: `fx37-unrelated-${tag()}`, affected: [{ introduced: "0", fixed: "9.0.0" }] });
    const q = new FakeQueue();
    await cron(q);
    expect(await deliveriesOf(depList)).toHaveLength(0);
    expect((await deliveriesOf(filterList)).map((r) => r.advisory_id)).toEqual([unrelated.id]);
    expect(q.forList(depList)).toHaveLength(0);
  });
});

describe("pass state", () => {
  it("aged: an advisory published 400 days before the upload gets a skipped row and no message", async () => {
    const name = `fx37-aged-${tag()}`;
    const { list } = await listWith([{ ecosystem: "npm", name, version: "1.0.0" }]);
    await alignMatchCursor();
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
    const adv = await seedAdvisory({ component: name, publishedAt: old, affected: [{ introduced: "0", fixed: "9.0.0" }] });
    const q = new FakeQueue();
    await cron(q);
    const rows = await deliveriesOf(list);
    expect(rows.map((r) => [r.advisory_id, r.status])).toEqual([[adv.id, "skipped"]]);
    expect(q.forList(list)).toHaveLength(0);
  });

  it("an upload rewinds the lane to its feed_cursor, and the next pass delivers", async () => {
    const name = `fx37-rew-${tag()}`;
    await setMatchCursor(2_000_000_000);
    const { list, feed_cursor } = await listWith([{ ecosystem: "npm", name, version: "1.0.0" }]);
    expect(await matchCursor()).toBe(feed_cursor);

    const adv = await seedAdvisory({ component: name, affected: [{ introduced: "0", fixed: "9.0.0" }] });
    const q = new FakeQueue();
    await cron(q);
    expect((await deliveriesOf(list)).map((r) => r.advisory_id)).toEqual([adv.id]);
    expect(await matchCursor()).toBeGreaterThanOrEqual(adv.cursor);
  });

  it("a pass whose start cursor moved under it (a concurrent upload) leaves the lane where the upload put it", async () => {
    const name = `fx37-cas-${tag()}`;
    const { list } = await listWith([{ ecosystem: "npm", name, version: "1.0.0" }]);
    await alignMatchCursor();
    const adv = await seedAdvisory({ component: name, affected: [{ introduced: "0", fixed: "9.0.0" }] });
    const rewindTo = adv.cursor - 1;

    // The first write batch of the pass sees the lane already moved by another writer.
    const real = env.DB;
    let moved = false;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!moved) {
              moved = true;
              await real.prepare("UPDATE match_cursors SET cursor = ? WHERE lane = 'dependencies'").bind(rewindTo - 1).run();
            }
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const q = new FakeQueue();
    const e: Env = { ...envWith(q as never), DB: db as D1Database };
    const res = await enqueueDependencyMatches(e, new Date());
    expect(moved).toBe(true);
    expect(res.cas_lost).toBe(1);
    expect(await matchCursor()).toBe(rewindTo - 1);
    // The PK stops a repeat when the next pass reads the window again.
    await cron(new FakeQueue());
    expect(await deliveriesOf(list)).toHaveLength(1);
  });
});

describe("upload during a pass", () => {
  it("a pass that read a set an upload replaced after the read writes no row for that list", async () => {
    const name = `fx37-mid-${tag()}`;
    const { list } = await listWith([{ ecosystem: "npm", name, version: "1.0.0" }]);
    await alignMatchCursor();
    const adv = await seedAdvisory({ component: name, affected: [{ introduced: "0", fixed: "9.0.0" }] });

    // After the pass read the stored dependencies (its first batch), the
    // upload commits: the list's check cursor is now at the advisory.
    const real = env.DB;
    let batches = 0;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            batches += 1;
            if (batches === 2) await real.prepare("UPDATE watchlists SET dependencies_cursor = ? WHERE id = ?").bind(adv.cursor, list).run();
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const q = new FakeQueue();
    const res = await enqueueDependencyMatches({ ...envWith(q as never), DB: db as D1Database }, new Date());
    expect(batches).toBeGreaterThanOrEqual(3);
    expect(res.pairs).toBeGreaterThanOrEqual(1);
    expect(await deliveriesOf(list)).toHaveLength(0);
    expect(q.forList(list)).toHaveLength(0);
  });
});

// The refute-review race: the upload read its check cursor F before advisory X
// existed, and its batch commits between the pass's dependency read and the
// pass's write batch. The lane stays at or below F, so only the version bump
// makes the pass lose its compare-and-set.
async function racedPass(list: string, keyId: string, newDeps: Dep[], f: number): Promise<DependencyMatchResult> {
  const real = env.DB;
  let batches = 0;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          batches += 1;
          if (batches === 2) {
            const now = new Date().toISOString();
            await real.batch([
              real.prepare(DEPENDENCY_DELETE_SQL).bind(list, keyId),
              real.prepare(DEPENDENCY_INSERT_SQL).bind(list, keyId, JSON.stringify(newDeps.map(dependencyRow))),
              real.prepare(DEPENDENCY_LIST_UPDATE_SQL).bind(list, keyId, f, now),
              real.prepare(MATCH_REWIND_SQL).bind(f, now),
            ]);
          }
          return target.batch(stmts);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const res = await enqueueDependencyMatches({ ...envWith(new FakeQueue() as never), DB: db as D1Database }, new Date());
  expect(batches).toBeGreaterThanOrEqual(2);
  return res;
}

describe("upload commits during a pass, check cursor below the new advisory", () => {
  it("a dependency the upload adds gets its delivery on the next pass", async () => {
    const oldName = `fx37-rca-${tag()}`;
    const newName = `fx37-rcb-${tag()}`;
    const key = await seedKey();
    const list = await seedList(key.id);
    expect((await upload(key.token, list, [{ ecosystem: "npm", name: oldName, version: "1.0.0" }])).status).toBe(200);
    await alignMatchCursor();
    const f = await matchCursor();
    // The new advisory affects only the added dependency.
    const adv = await seedAdvisory({ component: newName, affected: [{ introduced: "0", fixed: "9.0.0" }] });

    const res = await racedPass(list, key.id, [{ ecosystem: "npm", name: newName, version: "1.0.0" }], f);
    expect(res.cas_lost).toBe(1);
    expect(await matchCursor()).toBeLessThan(adv.cursor);

    await cron(new FakeQueue());
    expect((await deliveriesOf(list)).map((r) => r.advisory_id)).toEqual([adv.id]);
  });

  it("a dependency the upload removes gets no delivery", async () => {
    const oldName = `fx37-rcr-${tag()}`;
    const keepName = `fx37-rck-${tag()}`;
    const key = await seedKey();
    const list = await seedList(key.id);
    expect((await upload(key.token, list, [{ ecosystem: "npm", name: oldName, version: "1.0.0" }])).status).toBe(200);
    await alignMatchCursor();
    const f = await matchCursor();
    const adv = await seedAdvisory({ component: oldName, affected: [{ introduced: "0", fixed: "9.0.0" }] });

    const res = await racedPass(list, key.id, [{ ecosystem: "npm", name: keepName, version: "1.0.0" }], f);
    expect(res.pairs).toBeGreaterThanOrEqual(1);
    expect(res.cas_lost).toBe(1);
    expect(await deliveriesOf(list)).toHaveLength(0);

    await cron(new FakeQueue());
    await cron(new FakeQueue());
    expect(await deliveriesOf(list)).toHaveLength(0);
    expect(await matchCursor()).toBeGreaterThanOrEqual(adv.cursor);
  });
});

describe("payload", () => {
  it("a dependency list's webhook body is the advisory plus affected; a filter list's body is doc_json byte for byte", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const name = `fx37-pay-${tag()}`;
    const dep = { ecosystem: "npm", name, version: "1.0.0" };
    const { list } = await listWith([dep]);
    await alignMatchCursor();
    const adv = await seedAdvisory({ component: name, affected: [{ introduced: "0", fixed: "1.0.1" }] });
    await cron(new FakeQueue());

    const filterKey = await seedKey();
    const filterList = await seedList(filterKey.id);
    await insertDelivery({ watchlist_id: filterList, advisory_id: adv.id, cursor: adv.cursor });

    const f = new FakeFetch([200]);
    await runQueue(
      fakeBatch([
        { watchlist_id: list, advisory_id: adv.id },
        { watchlist_id: filterList, advisory_id: adv.id },
      ]),
      env as unknown as Env,
      {} as ExecutionContext,
      { fetch: f.fn, now: () => new Date() },
    );
    const depCall = f.calls.find((c) => c.url.endsWith(list));
    const filterCall = f.calls.find((c) => c.url.endsWith(filterList));
    expect(depCall).toBeDefined();
    const body = JSON.parse(depCall!.body) as { id: string; affected: Array<{ dependency: Dep; fixed_in: string; action: string; advisory_id: string }> };
    expect(body.id).toBe(adv.id);
    expect(body.affected).toHaveLength(1);
    expect(body.affected[0].dependency).toEqual(dep);
    expect(body.affected[0].fixed_in).toBe("1.0.1");
    expect(body.affected[0].advisory_id).toBe(adv.id);
    expect(typeof body.affected[0].action).toBe("string");
    expect(filterCall?.body).toBe(adv.doc_json);
  });
});

describe("filterAccepts", () => {
  it("keeps the same advisories as the watchlistWhere SQL over 20 advisories and 6 filters", async () => {
    const t = tag();
    const comps = [`fx37-fa-${t}`, `fx37-fb-${t}`];
    const ecos = ["npm", "PyPI", "Go", "node"];
    const labels = ["critical", "high", "medium", "low", "unknown"] as const;
    const ids: string[] = [];
    const start = (await topCursor());
    for (let i = 0; i < 20; i++) {
      const a = await seedAdvisory({ ecosystem: ecos[i % 4], component: comps[i % 2], label: labels[i % 5] });
      if (i % 3 === 0) await env.DB.prepare("UPDATE advisories SET exploited = 1 WHERE id = ?").bind(a.id).run();
      ids.push(a.id);
    }
    const base: WatchlistFilter = { ecosystems: [], components: [], runtimes: {}, min_severity: null, exploited_only: false };
    const filters: WatchlistFilter[] = [
      { ...base, components: comps },
      { ...base, components: comps, ecosystems: ["npm", "Go"] },
      { ...base, components: [comps[0]], min_severity: "high" },
      { ...base, components: comps, exploited_only: true },
      { ...base, components: comps, runtimes: { node: "24.0.0" }, min_severity: "medium" },
      { ...base, components: comps, ecosystems: ["PyPI"], min_severity: "low", exploited_only: true },
    ];
    const { results: rows } = await env.DB.prepare(
      "SELECT id, ecosystem, component, severity_label, exploited FROM advisories WHERE id IN (SELECT value FROM json_each(?))",
    )
      .bind(JSON.stringify(ids))
      .all<{ id: string; ecosystem: string; component: string; severity_label: string; exploited: number }>();
    expect(rows).toHaveLength(20);
    for (const f of filters) {
      const { where, params } = watchlistWhere(f, start);
      const { results } = await env.DB.prepare(`SELECT id FROM advisories WHERE ${where.join(" AND ")}`).bind(...params).all<{ id: string }>();
      const sqlIds = results.map((r) => r.id).filter((id) => ids.includes(id)).sort();
      const jsIds = rows.filter((r) => filterAccepts(f, r)).map((r) => r.id).sort();
      expect(jsIds).toEqual(sqlIds);
    }
  });
});

describe("filter enqueue", () => {
  it("WEBHOOK_LISTS_SQL reads a filter list and not a dependency list", async () => {
    const { list: depList } = await listWith([{ ecosystem: "npm", name: `fx37-wl-${tag()}`, version: "1.0.0" }]);
    const key = await seedKey();
    const filterList = await seedList(key.id);
    const { results } = await env.DB.prepare(WEBHOOK_LISTS_SQL).bind("", 1_000_000).all<{ id: string }>();
    const got = new Set(results.map((r) => r.id));
    expect(got.has(filterList)).toBe(true);
    expect(got.has(depList)).toBe(false);
  });
});
