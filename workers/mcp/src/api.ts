// The one seam to the Tocsin API. The MCP server reads the public API over
// HTTP only, so it works against any Tocsin host. Tests inject `fetch`.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiResult {
  ok: boolean;
  // 0 when the request never got an answer (network error).
  status: number;
  body: unknown;
  retryAfter: string | null;
}

export class TocsinApi {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.base = baseUrl;
  }

  events(params: Record<string, string>): Promise<ApiResult> {
    const url = this.url("/v1/events");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return this.send(url);
  }

  checkRuntimes(runtimes: Record<string, string>): Promise<ApiResult> {
    return this.send(this.url("/v1/check"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimes }),
    });
  }

  // The API reads lockfiles from multipart only; the field name is the file name.
  checkLockfile(name: string, text: string): Promise<ApiResult> {
    const form = new FormData();
    form.append(name, new Blob([text], { type: "text/plain" }), name);
    return this.send(this.url("/v1/check"), { method: "POST", body: form });
  }

  get(id: string): Promise<ApiResult> {
    return this.send(this.url(`/v1/events/${encodeURIComponent(id)}`));
  }

  getByCve(cve: string): Promise<ApiResult> {
    return this.send(this.url(`/v1/events/cve/${encodeURIComponent(cve)}`));
  }

  // The only call that carries the caller's API key.
  watchlistEvents(id: string, bearer: string): Promise<ApiResult> {
    return this.send(this.url(`/v1/watchlists/${encodeURIComponent(id)}/events`), {
      headers: { Authorization: `Bearer ${bearer}` },
    });
  }

  private url(path: string): URL {
    return new URL(path, this.base);
  }

  private async send(url: URL, init: RequestInit = {}): Promise<ApiResult> {
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), init);
    } catch (err) {
      return { ok: false, status: 0, body: { error: err instanceof Error ? err.message : String(err) }, retryAfter: null };
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: keep the text so the caller sees what the host answered.
    }
    return { ok: res.ok, status: res.status, body, retryAfter: res.headers.get("Retry-After") };
  }
}
