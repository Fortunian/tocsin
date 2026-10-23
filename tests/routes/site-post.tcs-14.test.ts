import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { POST_HASH } from "../../site/post.generated";
import { get } from "./seed.tcs-3";

// TCS-14: the launch post (docs/LAUNCH_POST.md) as a page at /blog/<slug>,
// through the production entry. `npm run gen:docs -- --check` proves the
// generated module matches the Markdown; CI runs it.
const ip = "198.51.100.41";
const PATH = "/blog/your-agents-fetch-was-exploitable";
const URL_ = `https://tocsin.sh${PATH}`;
const HEADING = "Your agent's fetch() was exploitable on October 21 and nothing told it";
const BODY_LINE = "I run agents all day. None of them knew.";

const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function ldOf(html: string): Record<string, unknown> {
  const raw = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  expect(raw, "JSON-LD script").toBeDefined();
  return JSON.parse(raw as string) as Record<string, unknown>;
}

describe("GET /blog/your-agents-fetch-was-exploitable", () => {
  it("returns 200 HTML with the post's first heading and its body", async () => {
    const res = await get(PATH, ip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const html = await res.text();
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "";
    expect(decode(h1.replace(/<[^>]+>/g, ""))).toBe(HEADING);
    expect(decode(html)).toContain(BODY_LINE);
    expect(html).toContain("<pre><code>npx tocsin connect</code></pre>");
    expect(html).toContain('<a href="https://github.com/Fortunian/tocsin">https://github.com/Fortunian/tocsin</a>');
    expect(decode(html)).toContain(`<title>${HEADING}</title>`);
  });

  it("has the canonical link and article JSON-LD with the author url", async () => {
    const html = await (await get(PATH, ip)).text();
    expect(html).toContain(`<link rel="canonical" href="${URL_}">`);
    const ld = ldOf(html);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Article");
    expect(ld.headline).toBe(HEADING);
    expect(ld.datePublished).toBe("2026-10-23");
    expect(ld.url).toBe(URL_);
    expect(ld.author).toEqual({ "@type": "Person", name: "Lior Weinstein", url: "https://www.linkedin.com/in/liorweinstein" });
  });

  it("answers 304 to its own ETag, which comes from the generated content hash", async () => {
    const first = await get(PATH, ip);
    const etag = first.headers.get("etag");
    expect(etag).toBe(`"${POST_HASH}"`);
    expect(POST_HASH).toMatch(/^[0-9a-f]{32}$/);
    const again = await get(PATH, ip, { "If-None-Match": etag as string });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
    const other = await get(PATH, ip, { "If-None-Match": '"0000"' });
    expect(other.status).toBe(200);
  });

  it("GET /blog redirects 302 to the post", async () => {
    const res = await exports.default.fetch("https://tocsin.test/blog", { redirect: "manual", headers: { "CF-Connecting-IP": ip } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(PATH);
  });
});

describe("the post is linked", () => {
  it("from the landing page, under the hook paragraph", async () => {
    const html = await (await get("/", ip)).text();
    const link = `<a href="${PATH}">Why: your agent&#39;s fetch() was exploitable on October 21 and nothing told it.</a>`;
    expect(html).toContain(link);
    expect(html.indexOf(link)).toBeGreaterThan(html.indexOf("Tocsin does. One feed. One command."));
    expect(html.indexOf(link)).toBeLessThan(html.indexOf('data-copy="npx tocsin connect"'));
  });

  it("from llms.txt and the sitemap", async () => {
    expect(await (await get("/llms.txt", ip)).text()).toContain(URL_);
    expect(await (await get("/sitemap.xml", ip)).text()).toContain(`<loc>${URL_}</loc>`);
  });
});
