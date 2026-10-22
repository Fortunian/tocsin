import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { LATEST_KEY, loadHome } from "../../src/site/data";
import { relativeTime } from "../../site/freshness";
import { get } from "./seed.tcs-3";

// TCS-35: the freshness line under Latest and the status badge, through the
// production entry (src/index.ts -> app).
const ip = "198.51.100.35";
const SOURCES = ["epss", "kev", "node-runtime", "nvd", "osv", "php-runtime"];

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// Every enabled source: a good run `agoMs` ago and no error.
async function allOk(agoMs: number): Promise<string> {
  const at = isoAgo(agoMs);
  await env.DB.prepare("UPDATE sources SET last_run_at = ?, last_ok_at = ?, last_error = NULL").bind(at, at).run();
  await env.CURSORS.delete(LATEST_KEY);
  return at;
}

async function failOne(id: string): Promise<void> {
  await env.DB.prepare("UPDATE sources SET last_error = ? WHERE id = ?").bind("fixture: HTTP 503", id).run();
  await env.CURSORS.delete(LATEST_KEY);
}

async function freshLine(): Promise<string> {
  const res = await get("/", ip);
  expect(res.status).toBe(200);
  const html = await res.text();
  const line = html.match(/<p class="fresh"[^>]*>[\s\S]*?<\/p>/)?.[0];
  expect(line, "no freshness line").toBeDefined();
  return line as string;
}

afterEach(async () => {
  await env.DB.prepare("UPDATE sources SET last_error = NULL").run();
  await env.CURSORS.delete(LATEST_KEY);
});

describe("freshness line on GET /", () => {
  it("reads 6 of 6 sources ok with a server-rendered relative time", async () => {
    const at = await allOk(5 * 60_000 + 2_000);
    const line = await freshLine();
    expect(line).toContain("6 of 6 sources ok");
    expect(line).toContain(`<time datetime="${at}" title="${at}">5 minutes ago</time>`);
    expect(line).toMatch(/^<p class="fresh">Updated <time/);
    expect(line).not.toContain('href="/status"');
    expect(line).not.toContain("style=");
  });

  it("reads 5 of 6 with one failed source, turns amber and links to /status", async () => {
    await allOk(60_000);
    await failOne("osv");
    const line = await freshLine();
    expect(line).toContain("5 of 6 sources ok");
    expect(line).toMatch(/<a href="\/status"[^>]*>5 of 6 sources ok<\/a>/);
    expect(line).toMatch(/^<p class="fresh" style="color:#f5a524">/);
  });

  it("counts a source that never ran as not ok", async () => {
    await allOk(60_000);
    await env.DB.prepare("UPDATE sources SET last_ok_at = NULL WHERE id = 'kev'").run();
    await env.CURSORS.delete(LATEST_KEY);
    expect(await freshLine()).toContain("5 of 6 sources ok");
  });

  it("sits under the Latest heading, before the table, and adds no script", async () => {
    await allOk(60_000);
    const html = await (await get("/", ip)).text();
    const h2 = html.indexOf("<h2>Latest</h2>");
    const fresh = html.indexOf('<p class="fresh"');
    expect(h2).toBeGreaterThanOrEqual(0);
    expect(fresh).toBeGreaterThan(h2);
    const next = html.slice(h2, fresh).replace("<h2>Latest</h2>", "").trim();
    expect(next).toBe("");
    expect((html.match(/<script\b/gi) ?? []).length).toBe(1);
  });

  it("serves the line from the KV cache until the key goes", async () => {
    await allOk(60_000);
    expect(await freshLine()).toContain("6 of 6 sources ok");
    await env.DB.prepare("UPDATE sources SET last_error = 'fixture: late' WHERE id = 'nvd'").run();
    expect(await freshLine()).toContain("6 of 6 sources ok");
    await env.CURSORS.delete(LATEST_KEY);
    expect(await freshLine()).toContain("5 of 6 sources ok");
  });
});

describe("one KV put for the Latest rows and the freshness line", () => {
  // The same bindings, with CURSORS.put counted.
  type Put = { key: string; value: string; opts?: KVNamespacePutOptions };
  function counted(): { env: Env; puts: Put[] } {
    const puts: Put[] = [];
    const kv = env.CURSORS;
    const wrapped = {
      get: kv.get.bind(kv),
      put: async (key: string, value: string, opts?: KVNamespacePutOptions) => {
        puts.push({ key, value, opts });
        return kv.put(key, value, opts);
      },
    } as unknown as KVNamespace;
    return { env: { ...(env as unknown as Env), CURSORS: wrapped }, puts };
  }

  it("writes rows and freshness in one put, then reads them back with no put", async () => {
    await allOk(60_000);
    const c = counted();
    const home = await loadHome(c.env);
    expect(c.puts.length).toBe(1);
    expect(c.puts[0].key).toBe(LATEST_KEY);
    const cached = JSON.parse(c.puts[0].value) as { rows: unknown; freshness: { ok: number; total: number; updated: string } };
    expect(Array.isArray(cached.rows)).toBe(true);
    expect(cached.freshness.ok).toBe(6);
    expect(cached.freshness.total).toBe(6);
    expect(home.freshness).toEqual(cached.freshness);

    const again = await loadHome(c.env);
    expect(c.puts.length).toBe(1);
    expect(again).toEqual(home);
  });

  it("treats a cached value in the old array shape as a miss", async () => {
    await allOk(60_000);
    await env.CURSORS.put(LATEST_KEY, JSON.stringify([]), { expirationTtl: 60 });
    const c = counted();
    const home = await loadHome(c.env);
    expect(c.puts.length).toBe(1);
    expect(home.freshness?.total).toBe(SOURCES.length);
  });

  it("puts with expirationTtl from the site.latest_cache_seconds row", async () => {
    await allOk(60_000);
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site.latest_cache_seconds'").first<{ value: string }>();
    expect(row, "settings row site.latest_cache_seconds").not.toBeNull();
    await env.DB.prepare("UPDATE settings SET value = '137' WHERE key = 'site.latest_cache_seconds'").run();
    try {
      const c = counted();
      await loadHome(c.env);
      expect(c.puts.length).toBe(1);
      expect(c.puts[0].opts?.expirationTtl).toBe(137);
    } finally {
      await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'site.latest_cache_seconds'").bind(row?.value ?? "60").run();
    }
  });

  it("caches nothing when the status read fails, and the page still renders the Latest table", async () => {
    await allOk(60_000);
    await breakStatus(async () => {
      const c = counted();
      const home = await loadHome(c.env);
      expect(c.puts.length).toBe(0);
      expect(home.freshness).toBeNull();
      expect(Array.isArray(home.rows)).toBe(true);

      const res = await get("/", ip);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<h2>Latest</h2>");
      expect(html).toMatch(/<tbody>|No advisories yet\./);
      expect(html).not.toContain('<p class="fresh"');
      expect(await env.CURSORS.get(LATEST_KEY)).toBeNull();
    });
  });
});

// Makes the loadStatus batch throw: the sources table is renamed for the
// duration of `fn`, then restored. The Latest read does not touch it.
async function breakStatus(fn: () => Promise<void>): Promise<void> {
  await env.DB.prepare("ALTER TABLE sources RENAME TO sources_tcs35").run();
  try {
    await fn();
  } finally {
    await env.DB.prepare("ALTER TABLE sources_tcs35 RENAME TO sources").run();
  }
}

describe("GET /badge/status.svg", () => {
  it("returns an SVG badge with 6/6 sources ok and max-age=300", async () => {
    await allOk(60_000);
    const res = await get("/badge/status.svg", ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const svg = await res.text();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain("<title>tocsin · 6/6 sources ok</title>");
    expect(svg).toContain(">tocsin</text>");
    expect(svg).toContain(">6/6 sources ok</text>");
    expect(svg).not.toContain("degraded");
    expect(svg).not.toMatch(/<script/i);
  });

  it("reads degraded when a source failed", async () => {
    await allOk(60_000);
    await failOne("php-runtime");
    const svg = await (await get("/badge/status.svg", ip)).text();
    expect(svg).toContain(">degraded</text>");
    expect(svg).toContain("<title>tocsin · degraded (5/6 sources ok)</title>");
    expect(svg).not.toContain(">6/6 sources ok</text>");
  });

  it("draws degraded with max-age=60 when the status read throws", async () => {
    await breakStatus(async () => {
      const res = await get("/badge/status.svg", ip);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      const svg = await res.text();
      expect(svg).toContain(">degraded</text>");
      expect(svg).not.toContain("sources ok</text>");
    });
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const cases: [string, string][] = [
    ["2026-10-22T11:59:30Z", "just now"],
    ["2026-10-22T12:00:30Z", "just now"],
    ["2026-10-22T11:59:00Z", "1 minute ago"],
    ["2026-10-22T11:15:00Z", "45 minutes ago"],
    ["2026-10-22T11:00:00Z", "1 hour ago"],
    ["2026-10-22T02:00:00Z", "10 hours ago"],
    ["2026-10-21T12:00:00Z", "1 day ago"],
    ["2026-10-19T11:00:00Z", "3 days ago"],
  ];
  it.each(cases)("%s -> %s", (iso, want) => {
    expect(relativeTime(iso, now)).toBe(want);
  });

  it("returns null for a value that is not a date", () => {
    expect(relativeTime("not a date", now)).toBeNull();
  });
});
