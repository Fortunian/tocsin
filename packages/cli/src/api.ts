// A small client for the public Tocsin API. It never logs the API key.
import type { Io } from "./io.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://tocsin.sh";

export interface ApiResult {
  ok: boolean;
  /** HTTP status. 0 when the request did not get an answer. */
  status: number;
  body: unknown;
  etag: string | null;
  retryAfter: number | null;
}

export class Api {
  readonly base: string;
  private readonly key: string | undefined;

  constructor(private readonly io: Io) {
    this.base = (io.env.TOCSIN_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.key = io.env.TOCSIN_API_KEY || undefined;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": `tocsin-cli/${VERSION}`, Accept: "application/json", ...extra };
    if (this.key) h.Authorization = `Bearer ${this.key}`;
    return h;
  }

  /** One multipart POST with every lockfile. The field name is the file name. */
  checkLockfiles(files: { name: string; text: string }[]): Promise<ApiResult> {
    const form = new FormData();
    for (const f of files) form.append(f.name, new Blob([f.text], { type: "text/plain" }), f.name);
    return this.send(`${this.base}/v1/check`, { method: "POST", headers: this.headers(), body: form });
  }

  checkRuntimes(runtimes: Record<string, string>): Promise<ApiResult> {
    return this.send(`${this.base}/v1/check`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ runtimes }),
    });
  }

  events(params: Record<string, string | number | undefined>, etag?: string | null): Promise<ApiResult> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    const headers = this.headers(etag ? { "If-None-Match": etag } : {});
    return this.send(`${this.base}/v1/events?${q}`, { method: "GET", headers });
  }

  private async send(url: string, init: RequestInit): Promise<ApiResult> {
    let res: Response;
    try {
      res = await this.io.fetch(url, init);
    } catch (e) {
      return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : String(e) }, etag: null, retryAfter: null };
    }
    const text = res.status === 304 ? "" : await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: keep the text, the caller reports it.
    }
    const ra = Number(res.headers.get("Retry-After"));
    return {
      ok: res.ok,
      status: res.status,
      body,
      etag: res.headers.get("ETag"),
      retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null,
    };
  }
}

/** The error text for a failed call, for one stderr line. */
export function describeFailure(r: ApiResult): string {
  const b = r.body;
  const msg =
    typeof b === "object" && b !== null && typeof (b as { error?: unknown }).error === "string"
      ? (b as { error: string }).error
      : typeof b === "string" && b
        ? b.slice(0, 200)
        : r.ok
          ? "unexpected answer body"
          : "no error text";
  const retry = r.status === 429 && r.retryAfter ? ` (retry after ${r.retryAfter} s)` : "";
  return `${r.status} ${msg}${retry}`;
}
