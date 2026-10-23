// The python-runtime seam: the PSF advisory database (GitHub contents API
// listing + raw record files), the CVE Services API and the python.org
// releases API. The only file that reads these URLs; the fetch function is
// injected, so tests pass the fake in tests/ingest/python-fake.tcs-39.ts.

export class PythonHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`Python source HTTP ${status} for ${url}`);
    this.name = "PythonHttpError";
  }
}

const UA = { "User-Agent": "tocsin.sh" };

async function getJson(fetchFn: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchFn(url, { headers });
  if (!res.ok) throw new PythonHttpError(res.status, url);
  return JSON.parse(await res.text());
}

export type ListingResult = { notModified: true } | { notModified: false; body: unknown; etag?: string };

// One conditional GitHub REST read (metered): the PSF advisories/python
// directory listing, or the CPython `v3.` tag refs. `token` is the optional
// GITHUB_TOKEN secret. `etag` makes the request conditional: a 304 answer
// does not count against the GitHub rate limit.
export async function fetchListing(fetchFn: typeof fetch, url: string, token: string | undefined, etag: string | undefined): Promise<ListingResult> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", ...UA, "X-GitHub-Api-Version": "2022-11-28" };
  if (token !== undefined && token.trim() !== "") headers.Authorization = `Bearer ${token.trim()}`;
  if (etag !== undefined) headers["If-None-Match"] = etag;
  const res = await fetchFn(url, { headers });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new PythonHttpError(res.status, url);
  const body: unknown = JSON.parse(await res.text());
  const tag = res.headers.get("ETag");
  return tag === null ? { notModified: false, body } : { notModified: false, body, etag: tag };
}

// The CPython tag refs (`git/matching-refs/tags/v3.`): the primary release source.
export const fetchTags = fetchListing;

// One PSF-YYYY-N.json record (OSV format) from raw.githubusercontent.com.
export function fetchPsfRecord(fetchFn: typeof fetch, base: string, psfId: string): Promise<unknown> {
  return getJson(fetchFn, `${base}/${encodeURIComponent(psfId)}.json`, UA);
}

// One CVE record (CVE JSON 5) from the CVE Services API.
export function fetchCveRecord(fetchFn: typeof fetch, base: string, cveId: string): Promise<unknown> {
  return getJson(fetchFn, `${base}/${encodeURIComponent(cveId)}`, { Accept: "application/json", ...UA });
}

// The python.org published releases list.
export function fetchReleases(fetchFn: typeof fetch, url: string): Promise<unknown> {
  return getJson(fetchFn, url, { Accept: "application/json", ...UA });
}
