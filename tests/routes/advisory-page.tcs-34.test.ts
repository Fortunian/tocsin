import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Advisory } from "../../src/schema/advisory";
import { docFor, get, idFor } from "./seed.tcs-3";

// The advisory pages (TCS-34) through the production entry (src/index.ts -> app).
const ip = "198.51.100.34";

// Inserts docs above every cursor in this file's D1. `mutate` edits each doc first.
async function seedDocs(prefix: string, n: number, mutate: (d: Advisory, i: number) => void): Promise<Advisory[]> {
  const max = await env.DB.prepare("SELECT COALESCE(MAX(cursor), 0) AS m FROM advisories").first<{ m: number }>();
  const base = (max?.m ?? 0) + 1;
  const insert = env.DB.prepare(
    `INSERT INTO advisories (id, cve_primary, ecosystem, component, severity_label, severity_score, exploited, epss, published_at, modified_at, doc_json, cursor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const docs = Array.from({ length: n }, (_, i) => {
    const d = docFor({ id: idFor(prefix, i), cursor: base + i });
    mutate(d, i);
    return d;
  });
  await env.DB.batch(
    docs.map((d, i) =>
      insert.bind(
        d.id,
        d.cve_ids[0] ?? null,
        d.ecosystem,
        d.component,
        d.severity.label,
        d.severity.score ?? null,
        d.exploited ? 1 : 0,
        d.epss ?? null,
        d.published_at,
        d.modified_at,
        JSON.stringify(d),
        base + i,
      ),
    ),
  );
  return docs;
}

function npmDoc(d: Advisory): void {
  d.ecosystem = "npm";
  d.component = "left-pad";
  d.cve_ids = ["CVE-2026-340001"];
  d.affected = [{ introduced: "0", fixed: "1.3.1" }];
  d.fixed_versions = ["1.3.1"];
  d.severity = { score: 9.8, label: "critical" };
  d.exploited = true;
  d.epss = 0.4567;
  d.summary = "Prototype pollution in left-pad via the pad character.";
  d.action = "Upgrade left-pad to 1.3.1 or later.";
  d.sources = [{ source: "osv", source_id: "GHSA-fixture-34", url: "https://example.com/fixture/left-pad" }];
}

const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/;

describe("GET /advisories/:id", () => {
  it("renders 200 HTML with the exact summary, action, fixed version, upgrade command, sources and canonical", async () => {
    const [d] = await seedDocs("PAG", 1, npmDoc);
    const res = await get(`/advisories/${d.id}`, ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("vary")).toMatch(/Accept/);
    expect(res.headers.get("link")).toBe(`</v1/events/${d.id}>; rel="alternate"; type="application/json"`);
    const html = await res.text();
    expect(html).toContain(d.summary);
    expect(html).toContain(d.action);
    expect(html).toContain("<td>1.3.1</td>");
    expect(html).toMatch(/<button[^>]*data-copy="npm i left-pad@1\.3\.1"/);
    expect(html).toContain("CVE-2026-340001");
    expect(html).toContain("critical 9.8");
    expect(html).toContain("exploited");
    expect(html).toContain("EPSS 45.67%");
    expect(html).toContain('href="https://example.com/fixture/left-pad"');
    expect(html).toContain(`<time datetime="${d.published_at}">`);
    expect(html).toContain(`<time datetime="${d.modified_at}">`);
    expect(html).toContain(`<link rel="canonical" href="https://tocsin.sh/advisories/${d.id}">`);
    const ld = html.match(LD_RE)?.[1];
    expect(ld).toBeDefined();
    const json = JSON.parse(ld as string) as Record<string, unknown>;
    expect(json["@type"]).toBe("TechArticle");
    expect(json.url).toBe(`https://tocsin.sh/advisories/${d.id}`);
    expect(json.dateModified).toBe(d.modified_at);
    expect(json.description).toBe(d.summary);
  });

  it("escapes advisory text and keeps </script> out of the JSON-LD", async () => {
    const [d] = await seedDocs("PXS", 1, (x) => {
      npmDoc(x);
      x.summary = "Bad </script><b>bold</b> & more";
    });
    const html = await (await get(`/advisories/${d.id}`, ip)).text();
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; more");
    const ld = html.match(LD_RE)?.[1] ?? "";
    expect(ld).not.toContain("</script");
    expect((JSON.parse(ld) as { description: string }).description).toBe(d.summary);
  });

  it("shows no upgrade command for a runtime and still shows the action", async () => {
    const [d] = await seedDocs("PRT", 1, () => {});
    const html = await (await get(`/advisories/${d.id}`, ip)).text();
    expect(html).toContain("Upgrade node to 24.22.1 or later.");
    expect(html).not.toContain("data-copy=");
  });

  it("answers an unknown id with a 404 HTML page", async () => {
    const res = await get(`/advisories/${idFor("NNN", 0)}`, ip);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("Advisory not found");
    const bad = await get("/advisories/not-an-id", ip);
    expect(bad.status).toBe(404);
    expect(bad.headers.get("content-type")).toMatch(/^text\/html/);
  });

  it("returns the advisory JSON for Accept: application/json", async () => {
    const [d] = await seedDocs("PJS", 1, npmDoc);
    const res = await get(`/advisories/${d.id}`, ip, { Accept: "application/json" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual(d);
    const miss = await get(`/advisories/${idFor("NNJ", 0)}`, ip, { Accept: "application/json" });
    expect(miss.status).toBe(404);
    expect(miss.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("a browser Accept header gets HTML", async () => {
    const [d] = await seedDocs("PBR", 1, npmDoc);
    const res = await get(`/advisories/${d.id}`, ip, { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" });
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  });

  it("round-trips the ETag to a 304, and a new modified_at changes it", async () => {
    const [d] = await seedDocs("PET", 1, npmDoc);
    const first = await get(`/advisories/${d.id}`, ip);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await get(`/advisories/${d.id}`, ip, { "If-None-Match": etag as string });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await again.text()).toBe("");
    const asJson = await get(`/advisories/${d.id}`, ip, { Accept: "application/json" });
    expect(asJson.headers.get("etag")).not.toBe(etag);
    await env.DB.prepare("UPDATE advisories SET modified_at = ? WHERE id = ?").bind("2026-10-22T00:00:00Z", d.id).run();
    const changed = await get(`/advisories/${d.id}`, ip, { "If-None-Match": etag as string });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });
});

describe("GET /cve/:cve", () => {
  it("lists every advisory that shares the CVE", async () => {
    const docs = await seedDocs("CVS", 2, (d, i) => {
      npmDoc(d);
      d.cve_ids = ["CVE-2026-340002"];
      d.component = ["left-pad", "right-pad"][i];
      d.action = `Upgrade ${d.component} to 1.3.1 or later.`;
    });
    const res = await get("/cve/cve-2026-340002", ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("link")).toBe(`</v1/events/cve/CVE-2026-340002>; rel="alternate"; type="application/json"`);
    const html = await res.text();
    for (const d of docs) {
      expect(html).toContain(`href="/advisories/${d.id}"`);
      expect(html).toContain(d.action);
    }
    expect(html).toMatch(/data-copy="npm i right-pad@1\.3\.1"/);
    expect(html).toContain('<link rel="canonical" href="https://tocsin.sh/cve/CVE-2026-340002">');
    expect(html).toContain("2 advisories");
  });

  it("returns the advisories as JSON and round-trips the ETag", async () => {
    const docs = await seedDocs("CVJ", 2, (d) => {
      npmDoc(d);
      d.cve_ids = ["CVE-2026-340003"];
    });
    const res = await get("/cve/CVE-2026-340003", ip, { Accept: "application/json" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cve: "CVE-2026-340003", advisories: docs });
    const html = await get("/cve/CVE-2026-340003", ip);
    const etag = html.headers.get("etag") as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await get("/cve/CVE-2026-340003", ip, { "If-None-Match": etag });
    expect(again.status).toBe(304);
  });

  it("answers an unknown or malformed CVE with a 404 HTML page", async () => {
    for (const p of ["/cve/CVE-2026-349999", "/cve/nope"]) {
      const res = await get(p, ip);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    }
  });
});

describe("GET /sitemap.xml", () => {
  it("lists the seeded advisory and CVE pages", async () => {
    const docs = await seedDocs("SMP", 2, (d, i) => {
      npmDoc(d);
      d.cve_ids = [`CVE-2026-34100${i}`];
    });
    const res = await get("/sitemap.xml", ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const xml = await res.text();
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    for (const d of docs) {
      expect(xml).toContain(`<loc>https://tocsin.sh/advisories/${d.id}</loc>`);
      expect(xml).toContain(`<loc>https://tocsin.sh/cve/${d.cve_ids[0]}</loc>`);
    }
    expect(xml).toContain(`<lastmod>${docs[0].modified_at}</lastmod>`);
  });

  it("turns into a sitemap index past one chunk, and each chunk lists its pages", async () => {
    const max = await env.DB.prepare("SELECT COALESCE(MAX(cursor), 0) AS m FROM advisories").first<{ m: number }>();
    const far = docFor({ id: idFor("SMF", 0), cursor: 0 });
    await env.DB.prepare(
      "INSERT INTO advisories (id, cve_primary, ecosystem, component, published_at, modified_at, doc_json, cursor) VALUES (?, NULL, 'node', 'node', ?, ?, ?, ?)",
    )
      .bind(far.id, far.published_at, far.modified_at, JSON.stringify(far), (max?.m ?? 0) + 60_000)
      .run();
    const xml = await (await get("/sitemap.xml", ip)).text();
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs[0]).toBe("https://tocsin.sh/sitemap-1.xml");
    expect(locs.length).toBeGreaterThanOrEqual(3);
    const last = await get(new URL(locs[locs.length - 1]).pathname, ip);
    expect(last.status).toBe(200);
    expect(await last.text()).toContain(`<loc>https://tocsin.sh/advisories/${far.id}</loc>`);
    const first = await (await get("/sitemap-1.xml", ip)).text();
    expect(first).toContain("<urlset");
    expect(first).not.toContain(far.id);
    expect((await get(`/sitemap-${locs.length + 1}.xml`, ip)).status).toBe(404);
    expect((await get("/sitemap-0.xml", ip)).status).toBe(404);
  });
});

describe("site links and llms.txt", () => {
  it("/llms.txt names the two page URL shapes and the sitemap", async () => {
    const text = await (await get("/llms.txt", ip)).text();
    expect(text).toContain("https://tocsin.sh/advisories/{id}");
    expect(text).toContain("https://tocsin.sh/cve/{cve}");
    expect(text).toContain("https://tocsin.sh/sitemap.xml");
  });

  it("the Latest table's component link opens the advisory page", async () => {
    const [d] = await seedDocs("QNK", 1, (x) => {
      npmDoc(x);
      x.published_at = "2099-01-01T00:00:00Z";
    });
    await env.CURSORS.delete("site:latest:v1");
    const html = await (await get("/", ip)).text();
    const href = html.match(/<tbody>[\s\S]*?<td><a href="([^"]+)">/)?.[1];
    expect(href).toBe(`/advisories/${d.id}`);
    expect((await get(href as string, ip)).status).toBe(200);
  });
});
