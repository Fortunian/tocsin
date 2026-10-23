// Test-mode fake for the GitHub advisories seam (src/ingest/github-advisories.ts).
// It answers from a URL -> answer map, records every call with its request
// headers, and throws on an unmapped URL, so a test that uses it makes 0
// network calls. It answers 304 when If-None-Match equals the answer's ETag,
// and sends a Link header when the answer has `next`.

export interface GhAnswer {
  status?: number;
  body?: string;
  etag?: string;
  next?: string;
}

export interface GhCall {
  url: string;
  headers: Record<string, string>;
  status: number;
}

export interface GhFake {
  fetch: typeof fetch;
  calls: GhCall[];
  urls(): string[];
  count(url: string): number;
}

export function createGhFake(routes: Record<string, string | GhAnswer>): GhFake {
  const calls: GhCall[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    if (!Object.hasOwn(routes, url)) {
      calls.push({ url, headers, status: 0 });
      throw new Error(`github-fake: unexpected URL ${url}`);
    }
    const raw = routes[url];
    const answer: GhAnswer = typeof raw === "string" ? { body: raw } : raw;
    const status = answer.status ?? 200;
    const out = new Headers();
    if (answer.etag !== undefined) out.set("ETag", answer.etag);
    if (answer.next !== undefined) out.set("Link", `<${answer.next}>; rel="next", <${answer.next}&last=1>; rel="last"`);
    if (status === 200 && answer.etag !== undefined && headers["if-none-match"] === answer.etag) {
      calls.push({ url, headers, status: 304 });
      return new Response(null, { status: 304, headers: out });
    }
    calls.push({ url, headers, status });
    return new Response(answer.body ?? "upstream error", { status, headers: out });
  };
  return {
    fetch: fakeFetch as typeof fetch,
    calls,
    urls: () => calls.map((c) => c.url),
    count: (url) => calls.filter((c) => c.url === url).length,
  };
}
