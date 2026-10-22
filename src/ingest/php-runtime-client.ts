// The php.net and php-src GitHub advisory seam. The only file that reads a
// php.net or api.github.com URL; the fetch function is injected, so tests
// pass the fake in tests/ingest/runtime-fake.tcs-6.ts.

export class PhpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`PHP source HTTP ${status} for ${url}`);
    this.name = "PhpHttpError";
  }
}

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
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "tocsin.sh",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token !== undefined && token.trim() !== "") headers.Authorization = `Bearer ${token.trim()}`;
  return JSON.parse(await getText(fetchFn, `${base}/${encodeURIComponent(ghsaId)}`, headers));
}
