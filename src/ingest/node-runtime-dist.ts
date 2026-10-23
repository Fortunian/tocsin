// The nodejs.org dist index for one node-runtime run, cached in KV (CURSORS).
// A fresh entry is used as is; a stale one is checked with a conditional GET,
// and a 304 reuses the cached set without a download.
import { fetchDistIndex } from "./node-runtime-client";

// KV (CURSORS): {etag?, fetched_at, versions} of the last dist index read.
// No expirationTtl: the ETag must outlive the freshness window.
export const NODE_DIST_KEY = "node-dist-index";

interface DistCache {
  etag?: string;
  fetched_at: string;
  versions: string[];
}

export interface DistIndex {
  versions: Set<string>;
  // True when the set came from KV without a request to origin in this call.
  fromCache: boolean;
}

function readCache(text: string | null): DistCache | undefined {
  if (text === null) return undefined;
  try {
    const c = JSON.parse(text) as DistCache;
    if (typeof c?.fetched_at !== "string" || Number.isNaN(Date.parse(c.fetched_at)) || !Array.isArray(c.versions)) return undefined;
    if (c.etag !== undefined && typeof c.etag !== "string") return undefined;
    return c;
  } catch {
    return undefined;
  }
}

// `force` skips the freshness window (a post needs a version the cached set lacks).
export async function loadNodeDistIndex(
  fetchFn: typeof fetch,
  kv: KVNamespace,
  url: string,
  ttlSeconds: number,
  now: Date,
  force: boolean,
): Promise<DistIndex> {
  const cache = readCache(await kv.get(NODE_DIST_KEY));
  if (cache !== undefined && !force && now.getTime() - Date.parse(cache.fetched_at) < ttlSeconds * 1000) {
    return { versions: new Set(cache.versions), fromCache: true };
  }
  const res = await fetchDistIndex(fetchFn, url, cache?.etag);
  const fetched_at = now.toISOString();
  if (res.notModified) {
    if (cache === undefined) throw new Error("304 with no cached dist index");
    await kv.put(NODE_DIST_KEY, JSON.stringify({ ...cache, fetched_at }));
    return { versions: new Set(cache.versions), fromCache: false };
  }
  const entry: DistCache = res.etag === undefined ? { fetched_at, versions: [...res.versions] } : { etag: res.etag, fetched_at, versions: [...res.versions] };
  await kv.put(NODE_DIST_KEY, JSON.stringify(entry));
  return { versions: res.versions, fromCache: false };
}
