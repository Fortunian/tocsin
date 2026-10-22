// The released CPython versions for one python-runtime run. Primary: the
// CPython git tags on GitHub (one conditional read; a 304 reuses the cached
// set in KV). Fallback, only when the GitHub read fails: the python.org
// releases API. python.org (Fastly) answered 403 to Cloudflare Workers egress
// on 2026-10-22, so it cannot be the primary source.
import { fetchReleases, fetchTags, PythonHttpError } from "./python-runtime-client";
import { parseCpythonTags, parsePythonReleases } from "./python-runtime-normalize";

// KV (CURSORS): {etag, versions} of the last full tag read.
export const PY_TAGS_KEY = "python:tags";

export class PythonReleasesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonReleasesError";
  }
}

export interface ReleaseSources {
  tagsUrl: string;
  releasesUrl: string;
  token: string | undefined;
}

interface TagCache {
  etag: string;
  versions: string[];
}

function readCache(text: string | null): TagCache | undefined {
  if (text === null) return undefined;
  try {
    const c = JSON.parse(text) as TagCache;
    return typeof c?.etag === "string" && Array.isArray(c.versions) ? c : undefined;
  } catch {
    return undefined;
  }
}

// "api.github.com HTTP 403", or the host and the error message.
function describe(err: unknown, url: string): string {
  if (err instanceof PythonHttpError) return `${new URL(err.url).host} HTTP ${err.status}`;
  return `${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`;
}

async function fromTags(fetchFn: typeof fetch, kv: KVNamespace, src: ReleaseSources): Promise<Set<string>> {
  const cache = readCache(await kv.get(PY_TAGS_KEY));
  const res = await fetchTags(fetchFn, src.tagsUrl, src.token, cache?.etag);
  if (res.notModified) {
    if (cache === undefined) throw new Error("304 with no cached tag list");
    return new Set(cache.versions);
  }
  const versions = parseCpythonTags(res.body);
  if (res.etag === undefined) await kv.delete(PY_TAGS_KEY);
  else await kv.put(PY_TAGS_KEY, JSON.stringify({ etag: res.etag, versions: [...versions] }));
  return versions;
}

/** One release-source read per run: GitHub tags, else python.org. Both failing throws, naming both hosts. */
export async function releasedVersions(fetchFn: typeof fetch, kv: KVNamespace, src: ReleaseSources): Promise<Set<string>> {
  let primary: string;
  try {
    return await fromTags(fetchFn, kv, src);
  } catch (err) {
    primary = describe(err, src.tagsUrl);
  }
  try {
    return parsePythonReleases(await fetchReleases(fetchFn, src.releasesUrl));
  } catch (err) {
    throw new PythonReleasesError(`release list unavailable: ${primary}; ${describe(err, src.releasesUrl)}`);
  }
}
