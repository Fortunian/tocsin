// Test-mode fake for the python-runtime seam (src/ingest/python-runtime-client.ts).
// It answers from a URL -> answer map, records every call with its headers,
// and throws on an unmapped URL, so a test that uses it makes 0 network calls.
// Unlike tests/ingest/runtime-fake.tcs-6.ts it sends response headers (ETag)
// and answers 304 when the request's If-None-Match equals the answer's ETag.

export interface PyAnswer {
  status?: number;
  body?: string;
  etag?: string;
}

export interface PyCall {
  url: string;
  headers: Record<string, string>;
  status: number;
}

export interface PyFake {
  fetch: typeof fetch;
  calls: PyCall[];
  urls(): string[];
  count(url: string): number;
}

export function createPyFake(routes: Record<string, string | PyAnswer>): PyFake {
  const calls: PyCall[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    if (!Object.hasOwn(routes, url)) {
      calls.push({ url, headers, status: 0 });
      throw new Error(`python-fake: unexpected URL ${url}`);
    }
    const raw = routes[url];
    const answer: PyAnswer = typeof raw === "string" ? { body: raw } : raw;
    const status = answer.status ?? 200;
    const out = new Headers();
    if (answer.etag !== undefined) out.set("ETag", answer.etag);
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
