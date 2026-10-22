import { LATEST_SQL } from "../../src/site/data";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Advisory } from "../../src/schema/advisory";
import { renderLanding } from "../../site/landing";
import { docFor, get, idFor, type SeedRow } from "./seed.tcs-3";

// The site pages through the production entry (src/index.ts -> app).
const ip = "198.51.100.40";
const KEY = "site:latest:v1";

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<\/?(a|code|time)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function landing(): Promise<string> {
  const res = await get("/", ip);
  expect(res.status).toBe(200);
  return res.text();
}

// Seeds rows above every cursor in this file's D1, so a test never depends on
// what an earlier test seeded. `mutate` edits the doc before the insert.
async function seedTop(prefix: string, n: number, mutate?: (d: Advisory, i: number) => void): Promise<Advisory[]> {
  const max = await env.DB.prepare("SELECT COALESCE(MAX(cursor), 0) AS m FROM advisories").first<{ m: number }>();
  const base = (max?.m ?? 0) + 1;
  const insert = env.DB.prepare(
    `INSERT INTO advisories (id, cve_primary, ecosystem, component, severity_label, exploited, published_at, modified_at, doc_json, cursor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const docs: Advisory[] = [];
  const stmts = Array.from({ length: n }, (_, i) => {
    const row: SeedRow = { id: idFor(prefix, i), cursor: base + i, component: `pkg-${prefix.toLowerCase()}-${i}`, ecosystem: "npm", cve: `CVE-2026-${7000 + i}` };
    const d = docFor(row);
    mutate?.(d, i);
    docs.push(d);
    return insert.bind(d.id, d.cve_ids[0] ?? null, d.ecosystem, d.component, d.severity.label, d.exploited ? 1 : 0, d.published_at, d.modified_at, JSON.stringify(d), row.cursor);
  });
  await env.DB.batch(stmts);
  return docs;
}

// The landing copy from the ticket, top to bottom (the table placeholder is
// replaced by the live table; comment 6329994269 set the free line).
const COPY = [
  "tocsin",
  "Security advisories, built for agents.",
  "Your agent runs on Node, PHP, Python, Go, Rust, Ruby and the packages on top of them. When one of them ships a critical fix, nothing tells the agent. Tocsin does. One feed. One command.",
  "npx tocsin connect",
  "Wires Claude Code, Cursor, Claude Desktop and Codex to the feed in one run.",
  "Or do it by hand:",
  'curl "https://tocsin.sh/v1/events?since=0&min_severity=high"',
  'curl "https://tocsin.sh/v1/check?node=24.22.0&php=8.4.26"',
  "npx tocsin check",
  "MCP: https://mcp.tocsin.sh/mcp",
  "Latest",
  "Free. No account to read. An API key (free) for watch lists and signed webhooks.",
  "Open source, Apache-2.0. github.com/Fortunian/tocsin",
  "Built with Cromford.",
  "docs · status · llms.txt",
];

describe("landing GET / (production entry)", () => {
  it("returns 200 HTML with the exact strings", async () => {
    const res = await get("/", ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain("npx tocsin connect");
    expect(html).toContain("Security advisories, built for agents.");
    expect(html).toContain("Built with Cromford");
  });

  it("ships the landing copy verbatim and in order", async () => {
    const text = stripTags(await landing());
    let at = 0;
    for (const line of COPY) {
      const i = text.indexOf(squash(line), at);
      expect(i, `missing or out of order: ${line}`).toBeGreaterThanOrEqual(0);
      at = i + squash(line).length;
    }
  });

  it("has the free line, no pricing, and no /pricing page", async () => {
    const html = await landing();
    expect(html).toContain("Free. No account to read. An API key (free) for watch lists and signed webhooks.");
    expect(html).not.toMatch(/pricing|\/mo\b|Pro plan/i);
    const res = await get("/pricing", ip);
    expect(res.status).toBe(404);
  });

  it("loads no external asset and has one inline script for the copy buttons", async () => {
    const html = await landing();
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain('<link href="http');
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/url\(\s*['"]?http/i);
    expect(html).not.toContain("@import");
    const scripts = html.match(/<script\b/gi) ?? [];
    expect(scripts.length).toBe(1);
    expect(html).toMatch(/<script>[\s\S]*data-copy[\s\S]*<\/script>/);
    expect(html).toMatch(/font-family:\s*system-ui/);
  });

  it("has a copy button for npx tocsin connect and each by-hand command", async () => {
    const html = await landing();
    expect(html).toMatch(/<button[^>]*data-copy="npx tocsin connect"/);
    expect(html).toContain('data-copy="curl &quot;https://tocsin.sh/v1/events?since=0&amp;min_severity=high&quot;"');
    expect(html).toContain('data-copy="curl &quot;https://tocsin.sh/v1/check?node=24.22.0&amp;php=8.4.26&quot;"');
    expect(html).toMatch(/<button[^>]*data-copy="npx tocsin check"/);
  });

  it("the Latest read uses idx_advisories_published_at (EXPLAIN QUERY PLAN)", async () => {
    await seedTop("XPQ", 60);
    await env.DB.prepare("ANALYZE").run();
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${LATEST_SQL}`).bind(10).all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toContain("idx_advisories_published_at");
    expect(plan).not.toMatch(/SCAN advisories(?! USING)/);
  });

  it("orders the Latest table by publish date, newest first, not by feed cursor", async () => {
    // Cursor order puts the newest-ingested row first; an old advisory re-touched by a source
    // must not land between fresh ones. Dates are deliberately out of cursor order.
    const days = [3, 9, 1, 12, 5, 2, 8, 4, 11, 6, 7, 10];
    await seedTop("SRT", 12, (d, i) => {
      d.published_at = `2026-10-${String(20 - days[i]).padStart(2, "0")}T00:00:00Z`;
    });
    await env.CURSORS.delete(KEY);
    const html = await landing();
    const dates = [...html.matchAll(/<time datetime="([^"]+)">/g)].map((m) => m[1]);
    expect(dates.length).toBe(10);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("links Cromford without rel and has the footer links", async () => {
    const html = await landing();
    expect(html).toContain('<a href="https://cromford.dev">Built with Cromford</a>.');
    const anchor = html.match(/<a [^>]*cromford\.ai[^>]*>/)?.[0] ?? "";
    expect(anchor).not.toContain("rel=");
    expect(html).toContain('href="https://github.com/Fortunian/tocsin"');
    for (const href of ["/docs", "/status", "/llms.txt"]) expect(html).toContain(`href="${href}"`);
  });
});

describe("landing Latest table", () => {
  it("shows the 10 newest advisories with the five columns and links", async () => {
    const docs = await seedTop("SNA", 12);
    await env.CURSORS.delete(KEY);
    const html = await landing();
    for (const d of docs.slice(2)) expect(html).toContain(`href="/v1/events/${d.id}"`);
    for (const d of docs.slice(0, 2)) expect(html).not.toContain(d.id);
    const head = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
    expect(stripTags(head).trim().split(" ")).toEqual(["when", "component", "CVE", "severity", "action"]);
    expect(html).toContain(`href="/v1/events/cve/${docs[11].cve_ids[0]}"`);
    expect(html).toContain(`npm/${docs[11].component}`);
    expect(html).toContain(`<time datetime="${docs[11].published_at}">${docs[11].published_at.slice(0, 10)}</time>`);
    expect(html).toContain(docs[11].action);
  });

  it("caches the rows in KV and reads D1 again after the key goes", async () => {
    await env.CURSORS.delete(KEY);
    await landing();
    expect(await env.CURSORS.get(KEY)).not.toBeNull();
    const [newer] = await seedTop("SNB", 1);
    expect(await landing()).not.toContain(newer.id);
    await env.CURSORS.delete(KEY);
    expect(await landing()).toContain(newer.id);
  });

  it("uses the site.latest_rows setting", async () => {
    const docs = await seedTop("SNC", 5);
    await env.DB.prepare("UPDATE settings SET value = '3' WHERE key = 'site.latest_rows'").run();
    try {
      await env.CURSORS.delete(KEY);
      const html = await landing();
      const body = html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? "";
      expect((body.match(/<tr>/g) ?? []).length).toBe(3);
      for (const d of docs.slice(2)) expect(body).toContain(d.id);
    } finally {
      await env.DB.prepare("UPDATE settings SET value = '10' WHERE key = 'site.latest_rows'").run();
      await env.CURSORS.delete(KEY);
    }
  });

  it("escapes advisory text", async () => {
    await seedTop("SND", 1, (d) => {
      d.action = "<img src=x onerror=alert(1)>";
    });
    await env.CURSORS.delete(KEY);
    const html = await landing();
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
  });

  it("renders the empty state and the failure state differently", () => {
    expect(renderLanding([])).toContain("No advisories yet.");
    const failed = renderLanding(null);
    expect(failed).toContain("Latest is not available right now.");
    expect(failed).not.toContain("No advisories yet.");
  });
});

describe("status", () => {
  it("GET /status lists every enabled source with last_ok_at, last_error and the newest cursor", async () => {
    await env.DB.prepare("UPDATE sources SET last_ok_at = ?, last_error = ? WHERE id = 'osv'")
      .bind("2026-10-22T10:00:00Z", "fixture: HTTP 503 from osv")
      .run();
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = 'epss'").run();
    try {
      const res = await get("/status", ip);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      const html = await res.text();
      for (const id of ["osv", "nvd", "kev", "node-runtime", "php-runtime"]) expect(html).toContain(`<td>${id}</td>`);
      expect(html).not.toContain("<td>epss</td>");
      expect(html).toContain("2026-10-22T10:00:00Z");
      expect(html).toContain("fixture: HTTP 503 from osv");
      expect(html).toContain("Newest cursor");
      expect(html).not.toContain("<script src=");
    } finally {
      await env.DB.prepare("UPDATE sources SET enabled = 1 WHERE id = 'epss'").run();
    }
  });

  it("GET /v1/status is JSON with sources[] and cursor", async () => {
    const [top] = await seedTop("STA", 1);
    const max = await env.DB.prepare("SELECT MAX(cursor) AS m FROM advisories").first<{ m: number }>();
    const res = await get("/v1/status", ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = (await res.json()) as { sources: Record<string, unknown>[]; cursor: unknown };
    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.sources.map((s) => s.id).sort()).toEqual(["epss", "kev", "node-runtime", "nvd", "osv", "php-runtime", "python-runtime"]);
    for (const s of body.sources) {
      expect(s).toHaveProperty("last_ok_at");
      expect(s).toHaveProperty("last_error");
    }
    expect(typeof body.cursor).toBe("number");
    expect(body.cursor).toBe(max?.m);
    expect(top.id).toMatch(/^tcs_STA/);
  });
});

describe("tocsin.so redirect", () => {
  const fetchHost = (url: string) => exports.default.fetch(url, { redirect: "manual", headers: { "CF-Connecting-IP": ip } });

  it("answers 301 to tocsin.sh with the path and query", async () => {
    const cases: [string, string][] = [
      ["https://tocsin.so/v1/events?since=5", "https://tocsin.sh/v1/events?since=5"],
      ["https://www.tocsin.so/", "https://tocsin.sh/"],
      ["https://TOCSIN.SO/docs", "https://tocsin.sh/docs"],
      ["https://tocsin.so:443/x", "https://tocsin.sh/x"],
      ["http://tocsin.so:8080/a/b?c=1&d=2", "https://tocsin.sh/a/b?c=1&d=2"],
    ];
    for (const [from, to] of cases) {
      const res = await fetchHost(from);
      expect(res.status, from).toBe(301);
      expect(res.headers.get("location"), from).toBe(to);
    }
  });

  it("does not redirect any other host", async () => {
    const hosts = ["tocsin.sh", "www.tocsin.sh", "mcp.tocsin.sh", "notocsin.so", "tocsin.so.example.com", "tocsin.sol", "tocsin.test", "localhost"];
    for (const h of hosts) {
      const res = await fetchHost(`https://${h}/v1/health`);
      expect(res.status, h).toBe(200);
    }
  });
});

describe("docs and neighbours", () => {
  it("GET /docs renders the API reference", async () => {
    const res = await get("/docs", ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await res.text();
    for (const s of ["Endpoints", "Advisory schema", "Cursor rule", "Rate limits", "Webhook signature", "npx tocsin connect", "/v1/status"]) {
      expect(html).toContain(s);
    }
    expect(html).not.toContain("<script src=");
    expect(html).not.toMatch(/<link\b/i);
  });

  it("keeps /llms.txt and the JSON 404", async () => {
    const llms = await get("/llms.txt", ip);
    expect(llms.status).toBe(200);
    expect(llms.headers.get("content-type")).toMatch(/^text\/plain/);
    const res = await get("/no-such-page", ip);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
