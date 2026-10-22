// The EPSS ingester: downloads the daily FIRST EPSS CSV once per run and
// writes `epss` on every advisory whose primary CVE has a score. An EPSS
// change alone does not bump the cursor (too noisy); a subscriber reads the
// new value with the advisory's next content change.
// This file is the EPSS seam: the only code that reads the EPSS CSV.
import { canonicalJson, checked } from "./upsert";
import { posIntConfig, urlConfig } from "./config";
import { cvePageSql, readCvePage } from "./cve-page";
import type { IngestContext, Ingester, RunResult } from "./types";
import type { Advisory } from "../schema/advisory";

export const EPSS_STATE_KEY = "epss:state";

// Code fallbacks for sources.config_json of row "epss" (repo iron rule 5).
// The documented epss.cyentia.com URL redirects to this host.
const DEFAULTS = {
  csv_url: "https://epss.empiricalsecurity.com/epss_scores-current.csv.gz",
  page_size: 500,
  max_pages: 20,
};

const CVE = /^CVE-\d{4}-\d{4,}$/;
const MAX_ERRORS = 20;

// idx_advisories_cve_primary.
export const EPSS_SQL = cvePageSql("id, cve_primary, epss, doc_json", "cve_primary IS NOT NULL");
// No cursor change, on purpose.
const UPDATE_SQL = "UPDATE advisories SET epss = ?, doc_json = ? WHERE id = ?";

// Progress of one score_date: `after` is the last CVE written, null when the day is done.
interface EpssState {
  score_date: string;
  after: string | null;
}

export class EpssHttpError extends Error {
  constructor(readonly status: number) {
    super(`EPSS CSV HTTP ${status}`);
    this.name = "EpssHttpError";
  }
}

export class EpssFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpssFormatError";
  }
}

// The body bytes, gunzipped when they start with the gzip magic bytes. (A
// server that sets Content-Encoding is already decoded by fetch.)
async function bodyText(res: Response): Promise<ReadableStream<string>> {
  if (!res.body) throw new EpssFormatError("EPSS CSV has no body");
  const reader = res.body.getReader();
  const first = await reader.read();
  const head = first.done ? new Uint8Array() : first.value;
  const bytes = new ReadableStream<Uint8Array>({
    start(c) {
      if (head.length > 0) c.enqueue(head);
      if (first.done) c.close();
    },
    async pull(c) {
      const r = await reader.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const gz = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const plain = gz ? bytes.pipeThrough(new DecompressionStream("gzip")) : bytes;
  return plain.pipeThrough(new TextDecoderStream());
}

async function* lines(text: ReadableStream<string>): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of text) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
    }
  }
  if (buf !== "") yield buf.replace(/\r$/, "");
}

function parseState(raw: string | null): EpssState | undefined {
  if (raw === null) return undefined;
  try {
    const v = JSON.parse(raw) as EpssState;
    return typeof v?.score_date === "string" && (v.after === null || typeof v.after === "string") ? v : undefined;
  } catch {
    return undefined;
  }
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const raw = ctx.source.config;
  const csvUrl = urlConfig(raw, "epss", "csv_url", DEFAULTS.csv_url);
  const pageSize = posIntConfig(raw, "epss", "page_size", DEFAULTS.page_size);
  const maxPages = posIntConfig(raw, "epss", "max_pages", DEFAULTS.max_pages);
  const kv = ctx.env.CURSORS;
  const db = ctx.env.DB;
  const result: RunResult = { fetched: 1, upserted: 0, unchanged: 0, errors: [] };

  const res = await ctx.fetch(csvUrl);
  if (!res.ok) throw new EpssHttpError(res.status);
  const it = lines(await bodyText(res));

  // Line 1: "#model_version:<v>,score_date:<timestamp>".
  const meta = (await it.next()).value ?? "";
  const scoreDate = meta.startsWith("#") ? /(?:^#|,)score_date:([^,\s]+)/.exec(meta)?.[1] : undefined;
  if (scoreDate === undefined) {
    await it.return(undefined);
    throw new EpssFormatError("EPSS CSV has no score_date line");
  }
  const state = parseState(await kv.get(EPSS_STATE_KEY));
  if (state?.score_date === scoreDate && state.after === null) {
    // This score_date is already applied: read no further.
    await it.return(undefined);
    result.incomplete = false;
    return result;
  }

  const header = (await it.next()).value ?? "";
  if (!header.startsWith("cve,epss")) throw new EpssFormatError(`EPSS CSV header is "${header.slice(0, 40)}"`);
  const scores = new Map<string, number>();
  for await (const line of it) {
    if (line === "") continue;
    const [cve, value] = line.split(",");
    const n = value === undefined || value.trim() === "" ? NaN : Number(value);
    if (!CVE.test(cve ?? "") || !Number.isFinite(n) || n < 0 || n > 1) {
      if (result.errors.length < MAX_ERRORS) result.errors.push(`EPSS row skipped: ${line.slice(0, 80)}`);
      continue;
    }
    scores.set(cve, n);
  }

  let after = state?.score_date === scoreDate ? (state.after ?? "") : "";
  let more = true;
  for (let p = 0; p < maxPages && more; p++) {
    const page = await readCvePage<{ id: string; cve_primary: string; epss: number | null; doc_json: string }>(db, EPSS_SQL, after, pageSize);
    const writes: D1PreparedStatement[] = [];
    for (const [cve, rows] of page.groups) {
      const value = scores.get(cve);
      for (const row of rows) {
        // A CVE absent from the CSV keeps its stored epss: absent is not 0.
        if (value === undefined || row.epss === value) {
          result.unchanged += 1;
          continue;
        }
        const doc = JSON.parse(row.doc_json) as Advisory;
        try {
          writes.push(db.prepare(UPDATE_SQL).bind(value, canonicalJson(checked({ ...doc, epss: value })), row.id));
        } catch (err) {
          if (result.errors.length < MAX_ERRORS) result.errors.push(`${cve}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (writes.length > 0) {
      for (const w of await db.batch(writes)) result.upserted += w.meta.changes ?? 0;
    }
    more = page.more;
    if (page.groups.length > 0) after = page.groups[page.groups.length - 1][0];
    await kv.put(EPSS_STATE_KEY, JSON.stringify({ score_date: scoreDate, after: more ? after : null } satisfies EpssState));
  }
  result.incomplete = more;
  return result;
}

export const epss: Ingester = { id: "epss", run };
