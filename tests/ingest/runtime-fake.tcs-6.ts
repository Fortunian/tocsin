// Test-mode fake for the runtime seams (src/ingest/node-runtime-client.ts and
// src/ingest/php-runtime-client.ts). It answers from a URL -> body map, records
// every call with its headers, and throws on an unmapped URL, so a test that
// uses it makes 0 network calls.

export type FakeAnswer = string | { status: number; body?: string };

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
}

export interface RuntimeFake {
  fetch: typeof fetch;
  calls: FakeCall[];
  urls(): string[];
  count(url: string): number;
}

export function createRuntimeFake(routes: Record<string, FakeAnswer>): RuntimeFake {
  const calls: FakeCall[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url, headers });
    if (!Object.hasOwn(routes, url)) throw new Error(`runtime-fake: unexpected URL ${url}`);
    const answer = routes[url];
    if (typeof answer === "string") return new Response(answer, { status: 200 });
    return new Response(answer.body ?? "upstream error", { status: answer.status });
  };
  return {
    fetch: fakeFetch as typeof fetch,
    calls,
    urls: () => calls.map((c) => c.url),
    count: (url) => calls.filter((c) => c.url === url).length,
  };
}
