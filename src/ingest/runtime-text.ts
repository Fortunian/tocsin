// Pure text helpers for the runtime ingesters (node-runtime, php-runtime):
// entity decoding, HTML heading sections, RSS items and runtime config.
// No I/O.

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

// Tags out, entities decoded, whitespace collapsed to single spaces.
export function htmlText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// One line, at most `max` chars.
export function oneLine(s: string, max = 200): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max).trim();
}

export interface HtmlSection {
  heading: string;
  body: string;
}

// Splits a page on its <h1> and <h2> headings. `heading` is the heading text;
// `body` is the raw HTML up to the next <h1>/<h2>.
export function htmlSections(html: string): HtmlSection[] {
  const re = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  const heads: { heading: string; start: number; end: number }[] = [];
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    heads.push({ heading: htmlText(m[2]), start: m.index, end: m.index + m[0].length });
  }
  return heads.map((h, i) => ({ heading: h.heading, body: html.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : html.length) }));
}

// The text of the first <name> element in an XML fragment, CDATA unwrapped.
export function xmlText(xml: string, name: string): string | undefined {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<${esc}\\b[^>]*>([\\s\\S]*?)</${esc}\\s*>`, "i").exec(xml);
  if (!m) return undefined;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return (cdata ? cdata[1] : decodeEntities(m[1])).trim();
}

export function xmlBlocks(xml: string, name: string): string[] {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...xml.matchAll(new RegExp(`<${esc}\\b[^>]*>([\\s\\S]*?)</${esc}\\s*>`, "gi"))].map((m) => m[1]);
}

// RFC3339 UTC with no millis, or undefined for an unparseable date.
export function isoUtc(date: string): string | undefined {
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Reads a runtime source's config_json against its code fallbacks (repo
// iron rule 5). A key named *_url or *_base must be an http(s) URL; a number
// must be a positive integer; a string must be non-empty.
export function readRuntimeConfig<T extends Record<string, string | number>>(source: string, raw: Record<string, unknown>, defaults: T): T {
  const cfg: Record<string, string | number> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof defaults[key] === "number") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${source} config: ${key} must be a positive integer`);
      cfg[key] = v;
    } else if (/_(url|base)$/.test(key)) {
      if (typeof v !== "string" || !/^https?:\/\//.test(v)) throw new Error(`${source} config: ${key} must be an http(s) URL`);
      cfg[key] = v.replace(/\/+$/, "");
    } else {
      if (typeof v !== "string" || v.trim() === "") throw new Error(`${source} config: ${key} must be a non-empty string`);
      cfg[key] = v;
    }
  }
  return cfg as T;
}

// A retry schedule knob: a comma list of positive integers (minutes).
export const RETRY_SCHEDULE = /^[1-9]\d*(,[1-9]\d*)*$/;

// The wait after failed attempt n (1-based) on the retry schedule; the last value repeats.
export function retryWaitMinutes(schedule: string, attempt: number): number {
  const waits = schedule.split(",").map(Number);
  return waits[Math.min(attempt, waits.length) - 1];
}

// The start of the read window: the stored cursor, else now - backfill_days.
export async function readSince(kv: KVNamespace, key: string, now: Date, backfillDays: number): Promise<{ stored: string | null; sinceMs: number }> {
  const stored = await kv.get(key);
  const storedMs = stored === null ? NaN : new Date(stored).getTime();
  return { stored, sinceMs: Number.isNaN(storedMs) ? now.getTime() - backfillDays * 86_400_000 : storedMs };
}
