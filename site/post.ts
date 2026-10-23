import { SITE_BASE, jsonLd } from "./advisory";
import { escapeHtml, page } from "./layout";
import { POST_HASH, POST_HTML, POST_TITLE } from "./post.generated";

// The launch post (TCS-14). post.generated.ts comes from docs/LAUNCH_POST.md
// (npm run gen:docs); its words are the client's final text.
export const POST_PATH = "/blog/your-agents-fetch-was-exploitable";
export const POST_URL = `${SITE_BASE}${POST_PATH}`;
export const POST_DATE = "2026-10-23";
export const POST_ETAG = `"${POST_HASH}"`;

const AUTHOR = { "@type": "Person", name: "Lior Weinstein", url: "https://www.linkedin.com/in/liorweinstein" };

function head(): string {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: POST_TITLE,
    url: POST_URL,
    mainEntityOfPage: POST_URL,
    datePublished: POST_DATE,
    author: AUTHOR,
    publisher: { "@type": "Organization", name: "Tocsin", url: SITE_BASE },
  };
  return `<link rel="canonical" href="${escapeHtml(POST_URL)}">\n${jsonLd(ld)}`;
}

export function renderPost(): string {
  const byline = `<p class="muted">By <a href="${AUTHOR.url}">${AUTHOR.name}</a> · <time datetime="${POST_DATE}">${POST_DATE}</time></p>`;
  const body = POST_HTML.replace(/<\/h1>/, () => `</h1>\n${byline}`);
  return page(POST_TITLE, `<article>\n${body}\n</article>`, { head: head() });
}
