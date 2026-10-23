// The GitHub repository security advisories seam, shared by deno-runtime and
// bun-runtime. The only file that reads the `/security-advisories` and
// `/releases` URLs of a runtime repo; the fetch function is injected, so tests
// pass the fake in tests/ingest/github-fake.tcs-41.ts.

export class GithubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`GitHub HTTP ${status} for ${url}`);
    this.name = "GithubHttpError";
  }
}

// A Link rel="next" URL that is not on the first page's origin. The link is
// not fetched: a GitHub answer must never make the worker call another host.
export class GithubLinkError extends Error {
  constructor(
    readonly url: string,
    readonly allowedOrigin: string,
  ) {
    super(`${url}: next link is not on ${allowedOrigin}, not read`);
    this.name = "GithubLinkError";
  }
}

export type AdvisoryPage = { notModified: true } | { notModified: false; body: unknown[]; etag?: string; next?: string };

export interface ReleasePage {
  body: unknown[];
  next?: string;
}

export function advisoriesPageUrl(base: string, pageSize: number): string {
  return `${base}?state=published&sort=published&direction=desc&per_page=${pageSize}`;
}

export function releasesPageUrl(base: string, pageSize: number): string {
  return `${base}?per_page=${pageSize}`;
}

// The rel="next" URL of a Link header, or undefined. A next URL on another origin throws.
export function nextLink(link: string | null, allowedOrigin: string): string | undefined {
  if (link === null) return undefined;
  for (const part of link.split(",")) {
    const m = /^\s*<([^>]*)>\s*;(.*)$/.exec(part);
    if (!m || !/\brel\s*=\s*"?next"?/.test(m[2])) continue;
    let origin: string;
    try {
      origin = new URL(m[1]).origin;
    } catch {
      throw new GithubLinkError(m[1], allowedOrigin);
    }
    if (origin !== allowedOrigin) throw new GithubLinkError(m[1], allowedOrigin);
    return m[1];
  }
  return undefined;
}

function headersFor(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "tocsin.sh", "X-GitHub-Api-Version": "2022-11-28" };
  if (token !== undefined && token.trim() !== "") headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

async function jsonArray(res: Response, url: string): Promise<unknown[]> {
  const body: unknown = JSON.parse(await res.text());
  if (!Array.isArray(body)) throw new Error(`GitHub answer at ${url} is not a JSON array`);
  return body;
}

// One advisories page (metered). `token` is the optional GITHUB_TOKEN secret.
// `etag` makes the request conditional: a 304 does not count against the
// GitHub rate limit. `allowedOrigin` bounds the next link.
export async function fetchAdvisoryPage(fetchFn: typeof fetch, url: string, token: string | undefined, allowedOrigin: string, etag?: string): Promise<AdvisoryPage> {
  const headers = headersFor(token);
  if (etag !== undefined) headers["If-None-Match"] = etag;
  const res = await fetchFn(url, { headers });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new GithubHttpError(res.status, url);
  const body = await jsonArray(res, url);
  const next = nextLink(res.headers.get("Link"), allowedOrigin);
  const tag = res.headers.get("ETag");
  return { notModified: false, body, ...(tag === null ? {} : { etag: tag }), ...(next === undefined ? {} : { next }) };
}

// One releases page (metered). Never conditional.
export async function fetchReleasePage(fetchFn: typeof fetch, url: string, token: string | undefined, allowedOrigin: string): Promise<ReleasePage> {
  const res = await fetchFn(url, { headers: headersFor(token) });
  if (!res.ok) throw new GithubHttpError(res.status, url);
  const body = await jsonArray(res, url);
  const next = nextLink(res.headers.get("Link"), allowedOrigin);
  return next === undefined ? { body } : { body, next };
}
