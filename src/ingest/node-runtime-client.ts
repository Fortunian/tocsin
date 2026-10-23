// The nodejs.org vendor seam. The only file that reads a nodejs.org URL; the
// fetch function is injected, so tests pass the fake in tests/ingest/runtime-fake.tcs-6.ts.

export class NodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`nodejs.org HTTP ${status} for ${url}`);
    this.name = "NodeHttpError";
  }
}

// A post link from the feed that is not on the feed's own origin. The link is
// not fetched: a feed item must never make the worker call another host.
export class NodeLinkError extends Error {
  constructor(
    readonly url: string,
    readonly allowedOrigin: string,
  ) {
    super(`${url}: post link is not on ${allowedOrigin}, not read`);
    this.name = "NodeLinkError";
  }
}

async function getText(fetchFn: typeof fetch, url: string): Promise<string> {
  const res = await fetchFn(url, { headers: { "User-Agent": "tocsin.sh" } });
  if (!res.ok) throw new NodeHttpError(res.status, url);
  return res.text();
}

// The vulnerability RSS feed.
export function fetchFeed(fetchFn: typeof fetch, url: string): Promise<string> {
  return getText(fetchFn, url);
}

// One security release post, by its feed link. Only a link on allowedOrigin is read.
export async function fetchPost(fetchFn: typeof fetch, url: string, allowedOrigin: string): Promise<string> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new NodeLinkError(url, allowedOrigin);
  }
  if (origin !== allowedOrigin) throw new NodeLinkError(url, allowedOrigin);
  return getText(fetchFn, url);
}

export type DistIndexResult = { notModified: true } | { notModified: false; versions: Set<string>; etag?: string };

// The release index: the set of published versions, with their "v" prefix.
// `etag` makes the request conditional: a 304 answer has no body.
export async function fetchDistIndex(fetchFn: typeof fetch, url: string, etag?: string): Promise<DistIndexResult> {
  const headers: Record<string, string> = { "User-Agent": "tocsin.sh" };
  if (etag !== undefined) headers["If-None-Match"] = etag;
  const res = await fetchFn(url, { headers });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new NodeHttpError(res.status, url);
  const body: unknown = JSON.parse(await res.text());
  if (!Array.isArray(body)) throw new Error(`nodejs.org dist index at ${url} is not a JSON array`);
  const versions = new Set<string>();
  for (const e of body) {
    const v = (e as { version?: unknown } | null)?.version;
    if (typeof v === "string") versions.add(v);
  }
  const tag = res.headers.get("ETag");
  return tag === null ? { notModified: false, versions } : { notModified: false, versions, etag: tag };
}
