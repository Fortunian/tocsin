// `tocsin latest` and `tocsin watch`: read GET /v1/events and print one line per event.
import { Api, describeFailure, type ApiResult } from "./api.js";
import type { Io } from "./io.js";

/** Poll interval for `watch`: 5 minutes, as the ticket sets it. A client constant: the CLI has no settings store. */
export const POLL_MS = 300_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface Event {
  id?: string;
  cve_ids?: string[];
  ecosystem?: string;
  component?: string;
  severity?: { label?: string };
  exploited?: boolean;
  published_at?: string;
  summary?: string;
}

interface Page {
  events: Event[];
  next_cursor: number;
  has_more: boolean;
}

function isPage(b: unknown): b is Page {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return Array.isArray(o.events) && typeof o.next_cursor === "number";
}

/** `<date> <severity> <ecosystem>/<component> <id>[ <first CVE>][ exploited]: <summary>` */
export function formatEvent(e: Event): string {
  const date = e.published_at ? e.published_at.slice(0, 10) : "-";
  const cve = e.cve_ids?.[0] ? ` ${e.cve_ids[0]}` : "";
  const exploited = e.exploited ? " exploited" : "";
  const summary = (e.summary ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
  return `${date} ${e.severity?.label ?? "unknown"} ${e.ecosystem ?? "?"}/${e.component ?? "?"} ${e.id ?? "?"}${cve}${exploited}: ${summary}`;
}

/** A non-negative integer from a flag, or null when the text is not one. */
function intFlag(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function usage(io: Io, verb: string, msg: string): number {
  io.err(`tocsin ${verb}: ${msg}`);
  return 2;
}

export async function runLatest(io: Io, values: Record<string, unknown>): Promise<number> {
  const since = values.since === undefined ? undefined : intFlag(values.since);
  if (since === null) return usage(io, "latest", "--since must be a cursor number (0 or more)");
  const limit = values.limit === undefined ? DEFAULT_LIMIT : intFlag(values.limit);
  if (limit === null || limit < 1 || limit > MAX_LIMIT) return usage(io, "latest", `--limit must be a number from 1 to ${MAX_LIMIT}`);

  const r = await new Api(io).events({ order: "desc", limit, ecosystem: values.ecosystem as string | undefined, since });
  if (!r.ok || !isPage(r.body)) {
    io.err(`latest failed: ${describeFailure(r)}`);
    return 3;
  }
  if (values.json) {
    io.out(JSON.stringify(r.body));
    return 0;
  }
  for (const e of r.body.events) io.out(formatEvent(e));
  io.err(`next_cursor: ${r.body.next_cursor}`);
  return 0;
}

export async function runWatch(io: Io, values: Record<string, unknown>): Promise<number> {
  let cursor: number | null = values.since === undefined ? null : intFlag(values.since);
  if (values.since !== undefined && cursor === null) return usage(io, "watch", "--since must be a cursor number (0 or more)");
  const ecosystem = values.ecosystem as string | undefined;
  const api = new Api(io);
  let etag: string | null = null;

  const failed = (r: ApiResult): number => {
    io.err(`watch: ${describeFailure(r)}; next try in ${r.status === 429 && r.retryAfter ? r.retryAfter : POLL_MS / 1000} s`);
    return r.status === 429 && r.retryAfter ? r.retryAfter * 1000 : POLL_MS;
  };

  for (let polls = 0; io.maxPolls === undefined || polls < io.maxPolls; ) {
    let wait = POLL_MS;
    if (cursor === null) {
      // Start at the newest event, so watch prints only what arrives after it starts.
      const r = await api.events({ order: "desc", limit: 1, ecosystem });
      if (r.ok && isPage(r.body)) cursor = r.body.next_cursor;
      else wait = failed(r);
    }
    if (cursor !== null) {
      polls++;
      for (;;) {
        const r = await api.events({ since: cursor, limit: MAX_LIMIT, ecosystem }, etag);
        if (r.status === 304) break;
        if (!r.ok || !isPage(r.body)) {
          wait = failed(r);
          break;
        }
        for (const e of r.body.events) io.out(formatEvent(e));
        // The cursor moves only after the page is printed.
        const advanced = r.body.next_cursor > cursor;
        cursor = r.body.next_cursor;
        etag = r.etag;
        if (!r.body.has_more || !advanced) break;
      }
      if (io.maxPolls !== undefined && polls >= io.maxPolls) break;
    }
    await io.sleep(wait);
  }
  return 0;
}
