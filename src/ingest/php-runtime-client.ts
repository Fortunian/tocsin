// The php.net and php-src GitHub advisory seam. The only file that reads a
// php.net or api.github.com URL; the fetch function is injected, so tests
// pass the fake in tests/ingest/runtime-fake.tcs-6.ts or
// tests/ingest/github-fake.tcs-41.ts.
import { nextLink } from "./github-advisories";

// `body` is the start of the answer body (the GitHub rate-limit text on a 403).
export class PhpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(`PHP source HTTP ${status} for ${url}${body === undefined ? "" : `: ${body}`}`);
    this.name = "PhpHttpError";
  }
}

// Chars of a failed answer body kept in PhpHttpError: the 1000-char bound of
// sources.last_error (MAX_ERROR_CHARS in registry.ts), not a tuning knob.
const ERROR_BODY_CHARS = 1000;

async function getText(fetchFn: typeof fetch, url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetchFn(url, { headers });
  if (!res.ok) throw new PhpHttpError(res.status, url);
  return res.text();
}

// The php.net news page (index.php), which carries the security advisory posts.
export function fetchNews(fetchFn: typeof fetch, url: string): Promise<string> {
  return getText(fetchFn, url, { "User-Agent": "tocsin.sh" });
}

// The php.net releases Atom feed.
export function fetchReleases(fetchFn: typeof fetch, url: string): Promise<string> {
  return getText(fetchFn, url, { "User-Agent": "tocsin.sh" });
}

// One php-src repository security advisory from the GitHub REST API.
// `token` is the optional GITHUB_TOKEN secret; without it the unauthenticated limit applies.
export async function fetchGhsa(fetchFn: typeof fetch, base: string, ghsaId: string, token: string | undefined): Promise<unknown> {
  return JSON.parse(await getText(fetchFn, `${base}/${encodeURIComponent(ghsaId)}`, githubHeaders(token)));
}

function githubHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "tocsin.sh",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token !== undefined && token.trim() !== "") headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

// One page of the php-src security advisories list (metered). A non-OK answer
// throws PhpHttpError with the start of its body. `allowedOrigin` bounds the
// Link rel="next" URL (GithubLinkError on another origin).
export async function fetchGhsaListPage(
  fetchFn: typeof fetch,
  url: string,
  token: string | undefined,
  allowedOrigin: string,
): Promise<{ body: unknown[]; next?: string }> {
  const res = await fetchFn(url, { headers: githubHeaders(token) });
  if (!res.ok) throw new PhpHttpError(res.status, url, (await res.text()).slice(0, ERROR_BODY_CHARS));
  const body: unknown = JSON.parse(await res.text());
  if (!Array.isArray(body)) throw new Error(`GitHub answer at ${url} is not a JSON array`);
  const next = nextLink(res.headers.get("Link"), allowedOrigin);
  return next === undefined ? { body } : { body, next };
}
