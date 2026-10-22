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

async function getText(fetchFn: typeof fetch, url: string): Promise<string> {
  const res = await fetchFn(url, { headers: { "User-Agent": "tocsin.sh" } });
  if (!res.ok) throw new NodeHttpError(res.status, url);
  return res.text();
}

// The vulnerability RSS feed.
export function fetchFeed(fetchFn: typeof fetch, url: string): Promise<string> {
  return getText(fetchFn, url);
}

// One security release post, by its feed link.
export function fetchPost(fetchFn: typeof fetch, url: string): Promise<string> {
  return getText(fetchFn, url);
}

// The release index: the set of published versions, with their "v" prefix.
export async function fetchDistIndex(fetchFn: typeof fetch, url: string): Promise<Set<string>> {
  const body: unknown = JSON.parse(await getText(fetchFn, url));
  if (!Array.isArray(body)) throw new Error(`nodejs.org dist index at ${url} is not a JSON array`);
  const versions = new Set<string>();
  for (const e of body) {
    const v = (e as { version?: unknown } | null)?.version;
    if (typeof v === "string") versions.add(v);
  }
  return versions;
}
