import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import app from "../../src/app";
import { afterEach, describe, expect, it } from "vitest";
import { setKnob } from "../queue/helpers.tcs-11";

// TCS-101: GET /badge/<owner>/<repo>.svg through the production entry
// (src/index.ts -> app). Each test reads its own repo, so no test meets
// another test's rows or edge cache entries.

const ip = "198.51.100.102";
const get = (path: string) => exports.default.fetch(`https://tocsin.test${path}`, { headers: { "CF-Connecting-IP": ip } });

let nextRun = 1;
async function report(owner: string, repo: string, o: { ref?: string; affected?: number; isDefault?: boolean; minSeverity?: string; at?: string } = {}) {
  const ref = o.ref ?? "refs/heads/main";
  await env.DB.batch([
    env.DB.prepare("UPDATE action_reports SET is_latest = 0 WHERE owner = ? AND repo = ? AND ref = ?").bind(owner, repo, ref),
    env.DB.prepare(
      "INSERT INTO action_reports (owner, repo, ref, is_default, is_latest, affected, min_severity, run_id, reported_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
    ).bind(owner, repo, ref, (o.isDefault ?? ref === "refs/heads/main") ? 1 : 0, o.affected ?? 0, o.minSeverity ?? "low", String(nextRun++), o.at ?? "2026-10-25T10:00:00.000Z"),
  ]);
}

afterEach(async () => {
  await setKnob("badge.cache_seconds", "300");
});

describe("GET /badge/:owner/:repo.svg", () => {
  it("B1: no report is a grey unknown badge", async () => {
    const res = await get("/badge/acme-b1/widget.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    const svg = await res.text();
    expect(svg).toContain(">tocsin<");
    expect(svg).toContain(">unknown<");
    expect(svg).toContain('fill="#9f9f9f"');
  });

  it("B2: 0 affected on the default branch is a green clean badge", async () => {
    await report("acme-b2", "widget", { affected: 0 });
    const svg = await (await get("/badge/acme-b2/widget.svg")).text();
    expect(svg).toContain(">clean<");
    expect(svg).toContain('fill="#2e9e44"');
    expect(svg).not.toContain(">unknown<");
  });

  it("B3: 3 affected is a red badge; the title names the severity floor and the date", async () => {
    await report("acme-b3", "widget", { affected: 3, minSeverity: "high", at: "2026-10-24T09:00:00.000Z" });
    const svg = await (await get("/badge/acme-b3/widget.svg")).text();
    expect(svg).toContain(">3 affected<");
    expect(svg).toContain('fill="#e05d44"');
    expect(svg).toContain("<title>tocsin · 3 affected (high or above, 2026-10-24)</title>");
  });

  it("B4: ?ref= picks that ref's row; short and full ref are the same; an unknown ref is unknown", async () => {
    await report("acme-b4", "widget", { affected: 0 });
    await report("acme-b4", "widget", { ref: "refs/heads/feature-x", affected: 5 });
    expect(await (await get("/badge/acme-b4/widget.svg")).text()).toContain(">clean<");
    expect(await (await get("/badge/acme-b4/widget.svg?ref=feature-x")).text()).toContain(">5 affected<");
    expect(await (await get("/badge/acme-b4/widget.svg?ref=refs/heads/feature-x")).text()).toContain(">5 affected<");
    expect(await (await get("/badge/acme-b4/widget.svg?ref=none-such")).text()).toContain(">unknown<");
  });

  it("B5: the default badge reads the newest default-branch row, not an older one or a PR ref", async () => {
    await report("acme-b5", "widget", { affected: 4 });
    await report("acme-b5", "widget", { affected: 1 });
    await report("acme-b5", "widget", { ref: "refs/pull/7/merge", affected: 9 });
    expect(await (await get("/badge/acme-b5/widget.svg")).text()).toContain(">1 affected<");
  });

  it("B6: Cache-Control comes from badge.cache_seconds", async () => {
    const res = await get("/badge/acme-b6/widget.svg");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    await setKnob("badge.cache_seconds", "120");
    const res2 = await get("/badge/acme-b6b/widget.svg");
    expect(res2.headers.get("Cache-Control")).toBe("public, max-age=120");
  });

  it("B7: a second fetch after the row is deleted still serves the cached SVG (edge cache hit)", async () => {
    await report("acme-b7", "widget", { affected: 2 });
    const first = await (await get("/badge/acme-b7/widget.svg")).text();
    expect(first).toContain(">2 affected<");
    await env.DB.prepare("DELETE FROM action_reports WHERE owner = 'acme-b7'").run();
    const second = await (await get("/badge/acme-b7/widget.svg")).text();
    expect(second).toBe(first);
    // The cache key ignores the case of owner/repo and any other query param.
    expect(await (await get("/badge/Acme-B7/Widget.svg?utm=fixture")).text()).toBe(first);
  });

  it("B8: an invalid owner is 404", async () => {
    const res = await get("/badge/a%20b/widget.svg");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("B9: two fetches give identical bytes", async () => {
    await report("acme-b9", "widget", { affected: 0 });
    const a = await (await get("/badge/acme-b9/widget.svg")).text();
    const b = await (await get("/badge/acme-b9/widget.svg?ref=main")).text();
    expect(b).toBe(a);
  });

  it("B10: owner/repo lookup is case-insensitive (a write of acme-b10/widget, a read of Acme-B10/Widget)", async () => {
    await report("acme-b10", "widget", { affected: 0 });
    expect(await (await get("/badge/Acme-B10/Widget.svg")).text()).toContain(">clean<");
  });

  it("B11: a report for repo A does not show on repo B", async () => {
    await report("acme-b11", "repo-a", { affected: 6 });
    expect(await (await get("/badge/acme-b11/repo-b.svg")).text()).toContain(">unknown<");
  });

  it("B12: /badge/status.svg still answers the feed badge", async () => {
    const res = await get("/badge/status.svg");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/sources ok|degraded/);
  });

  it("B13: a failed DB read draws unavailable with no-cache, and caches nothing", async () => {
    const broken = { prepare: () => { throw new Error("fixture: D1 down"); } } as unknown as D1Database;
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request("https://tocsin.test/badge/acme-b13/widget.svg"), { ...env, DB: broken }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const svg = await res.text();
    expect(svg).toContain(">unavailable<");
    expect(svg).not.toContain(">unknown<");
    // The next good read is not served a cached error.
    await report("acme-b13", "widget", { affected: 0 });
    expect(await (await get("/badge/acme-b13/widget.svg")).text()).toContain(">clean<");
  });
});
