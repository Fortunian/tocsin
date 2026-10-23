// The OSV ingester: lists ids modified since the KV cursor from OSV's
// per-ecosystem modified_id.csv, fetches each record, normalizes it to
// advisory v1 and upserts it. The cursor moves only after a full page.
import { cvss3BaseScore, labelFromScore } from "./cvss";
import { getVuln, listModifiedSince, type ModifiedRow } from "./osv-client";
import type { AdvisoryInput, IngestContext, Ingester, RunResult } from "./types";
import { InvalidAdvisoryError, upsertAdvisory } from "./upsert";
import type { AffectedRange, SeverityLabel } from "../schema/advisory";

export const CURSOR_KEY = "cursor:osv";
// The osv sources row config (PK of sources), for readers outside the cron run.
export const OSV_CONFIG_SQL = "SELECT config_json FROM sources WHERE id = 'osv'";

// Code fallbacks for sources.config_json of row "osv" (repo iron rule 5).
export const DEFAULT_ECOSYSTEMS = ["npm", "PyPI", "Go", "Packagist", "crates.io", "RubyGems"];
const DEFAULTS = {
  ecosystems: DEFAULT_ECOSYSTEMS,
  page_size: 25,
  max_pages: 4,
  backfill_days: 7,
  // MAL- ids are malicious-package reports; "Pin and monitor" is the wrong action for them.
  skip_id_prefixes: ["MAL-"],
  max_csv_rows: 200000,
  csv_base: "https://osv-vulnerabilities.storage.googleapis.com",
  api_base: "https://api.osv.dev",
};
type OsvConfig = typeof DEFAULTS;

export interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}
export interface OsvAffected {
  package?: { ecosystem?: string; name?: string; purl?: string };
  ranges?: { type?: string; events?: OsvEvent[] }[];
  versions?: string[];
  [k: string]: unknown;
}
export interface OsvVuln {
  id: string;
  modified: string;
  published?: string;
  withdrawn?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: { type?: string; score?: string }[];
  affected?: OsvAffected[];
  references?: { type?: string; url?: string }[];
  database_specific?: Record<string, unknown>;
  [k: string]: unknown;
}

// One doc per enabled package of the record; `doc` is docs[0].doc.
export type NormalizeResult =
  | { ok: true; doc: AdvisoryInput; docs: { source_id: string; doc: AdvisoryInput }[] }
  | { ok: false; reason: string };

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;
const CVE = /^CVE-\d{4}-\d{4,}$/;
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const DB_SEVERITY: Record<string, SeverityLabel> = { CRITICAL: "critical", HIGH: "high", MODERATE: "medium", LOW: "low" };
const NO_FIX = "No fix published. Pin and monitor.";

// Sort key for an RFC3339 UTC timestamp. The fraction is padded to 9 digits
// so "05Z" sorts before "05.2Z" (a raw string compare puts "." before "Z").
export function modKey(ts: string): string {
  let m = TIMESTAMP.exec(ts);
  if (!m) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) throw new Error(`invalid OSV timestamp: ${ts}`);
    m = TIMESTAMP.exec(d.toISOString())!;
  }
  return `${m[1]}.${(m[2] ?? "").padEnd(9, "0").slice(0, 9)}`;
}

function schemaTimestamp(ts: string): string | undefined {
  if (TIMESTAMP.test(ts)) return ts;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Cuts a list sorted by modified into pages of `size`. A page never splits a
// group of equal modified values, so a "> cursor" read can never drop a record.
export function paginate<T extends { modified: string }>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  let i = 0;
  while (i < items.length) {
    let end = Math.min(i + size, items.length);
    while (end < items.length && modKey(items[end].modified) === modKey(items[end - 1].modified)) end++;
    pages.push(items.slice(i, end));
    i = end;
  }
  return pages;
}

function versionParts(v: string): { main: string[]; pre: string } {
  const s = v.replace(/^[vV]/, "");
  const cut = s.search(/[-+]/);
  const main = cut === -1 ? s : s.slice(0, cut);
  const pre = cut === -1 || s[cut] === "+" ? "" : s.slice(cut + 1).replace(/\+.*$/, "");
  return { main: main.split("."), pre };
}

function comparePart(a: string, b: string): number {
  const ma = /^(\d*)(.*)$/.exec(a)!;
  const mb = /^(\d*)(.*)$/.exec(b)!;
  const na = ma[1] === "" ? -1 : Number(ma[1]);
  const nb = mb[1] === "" ? -1 : Number(mb[1]);
  if (na !== nb) return na < nb ? -1 : 1;
  // "0" sorts above "0rc1": a tag after the number is a pre-release.
  if (ma[2] === mb[2]) return 0;
  if (ma[2] === "") return 1;
  if (mb[2] === "") return -1;
  return ma[2] < mb[2] ? -1 : 1;
}

// Dotted numeric compare; a pre-release tag sorts below its release.
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const n = Math.max(pa.main.length, pb.main.length);
  for (let i = 0; i < n; i++) {
    const c = comparePart(pa.main[i] ?? "0", pb.main[i] ?? "0");
    if (c !== 0) return c;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  const xa = pa.pre.split(".");
  const xb = pb.pre.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const c = comparePart(xa[i], xb[i]);
    if (c !== 0) return c;
  }
  return 0;
}

function eventVersion(e: OsvEvent): string | undefined {
  return e.introduced ?? e.fixed ?? e.last_affected;
}

// Pairs from SEMVER / ECOSYSTEM range events, ordered by version as OSV
// evaluates them. GIT ranges carry commit hashes, not versions, and are skipped.
function rangesOf(entries: OsvAffected[]): { affected: AffectedRange[]; fixed: string[] } {
  const affected: AffectedRange[] = [];
  const fixed: string[] = [];
  for (const entry of entries) {
    for (const range of entry.ranges ?? []) {
      if (range.type !== "SEMVER" && range.type !== "ECOSYSTEM") continue;
      const events = (range.events ?? []).filter((e) => typeof eventVersion(e) === "string" && e.limit === undefined);
      for (const e of events) if (typeof e.fixed === "string" && !fixed.includes(e.fixed)) fixed.push(e.fixed);
      const sorted = events
        .map((e, i) => ({ e, i }))
        .sort((x, y) => compareVersions(eventVersion(x.e)!, eventVersion(y.e)!) || x.i - y.i)
        .map((x) => x.e);
      let open: string | undefined;
      for (const e of sorted) {
        if (e.introduced !== undefined) {
          // An introduced event while already affected changes nothing.
          if (open === undefined) open = e.introduced;
        } else if (open !== undefined) {
          affected.push(e.fixed !== undefined ? { introduced: open, fixed: e.fixed } : { introduced: open, last_affected: e.last_affected });
          open = undefined;
        }
      }
      if (open !== undefined) affected.push({ introduced: open });
    }
  }
  return { affected, fixed };
}

function severityOf(v: OsvVuln): { score?: number; label: SeverityLabel } {
  for (const s of v.severity ?? []) {
    if (typeof s.score !== "string") continue;
    const score = cvss3BaseScore(s.score);
    if (score !== undefined) return { score, label: labelFromScore(score) };
  }
  const db = v.database_specific?.severity;
  if (typeof db === "string" && DB_SEVERITY[db.toUpperCase()]) return { label: DB_SEVERITY[db.toUpperCase()] };
  return { label: "unknown" };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 200).trim();
}

function summaryOf(v: OsvVuln, component: string): string {
  if (typeof v.summary === "string" && oneLine(v.summary) !== "") return oneLine(v.summary);
  if (typeof v.details === "string") {
    const first = v.details.split(/\r?\n/).find((l) => l.trim() !== "");
    if (first) return oneLine(first);
  }
  return oneLine(`Advisory ${v.id} affects ${component}.`);
}

// The source key of the package at `index` in a record. The first package keeps
// the bare OSV id, so rows stored before TCS-46 keep their key.
export function osvSourceId(id: string, index: number, ecosystem: string, name: string): string {
  return index === 0 ? id : `${id}#${ecosystem}/${name}`;
}

export function normalizeOsv(v: OsvVuln, ecosystems: string[]): NormalizeResult {
  if (typeof v?.id !== "string" || v.id === "") return { ok: false, reason: "record has no id" };
  if (typeof v.modified !== "string") return { ok: false, reason: "record has no modified" };
  const affectedList = Array.isArray(v.affected) ? v.affected : [];
  // Distinct enabled (ecosystem, name) pairs, in first-appearance order.
  const packages: { ecosystem: string; component: string }[] = [];
  for (const a of affectedList) {
    const ecosystem = a.package?.ecosystem;
    const component = a.package?.name;
    if (typeof ecosystem !== "string" || !ecosystems.includes(ecosystem) || typeof component !== "string" || component === "") continue;
    if (!packages.some((p) => p.ecosystem === ecosystem && p.component === component)) packages.push({ ecosystem, component });
  }
  if (packages.length === 0) return { ok: false, reason: "no affected package in a listed ecosystem" };

  const modified_at = schemaTimestamp(v.modified);
  const published_at = schemaTimestamp(typeof v.published === "string" ? v.published : v.modified);
  if (!modified_at || !published_at) return { ok: false, reason: "unparseable published/modified timestamp" };

  const ids = [v.id, ...(Array.isArray(v.aliases) ? v.aliases : [])].filter((x): x is string => typeof x === "string");
  const cve_ids = [...new Set(ids.filter((x) => CVE.test(x)))].sort();
  const ghsa_id = ids.find((x) => GHSA.test(x));
  const osvUrl = `https://osv.dev/vulnerability/${v.id}`;
  const refs = (Array.isArray(v.references) ? v.references : [])
    .map((r) => r?.url)
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  const severity = severityOf(v);

  const docs = packages.map(({ ecosystem, component }, i) => {
    const same = affectedList.filter((a) => a.package?.ecosystem === ecosystem && a.package?.name === component);
    const { affected, fixed } = rangesOf(same);
    const lowest = [...fixed].sort(compareVersions)[0];
    const source_id = osvSourceId(v.id, i, ecosystem, component);
    const doc: AdvisoryInput = {
      cve_ids,
      ...(ghsa_id ? { ghsa_id } : {}),
      ecosystem,
      component,
      affected,
      fixed_versions: fixed,
      severity,
      exploited: false,
      published_at,
      modified_at,
      summary: summaryOf(v, component),
      action: lowest !== undefined ? oneLine(`Upgrade ${component} to ${lowest} or later.`) : NO_FIX,
      references: [...new Set([osvUrl, ...refs])],
      sources: [{ source: "osv", source_id, url: osvUrl }],
    };
    return { source_id, doc };
  });
  return { ok: true, doc: docs[0].doc, docs };
}

export function readConfig(raw: Record<string, unknown>): OsvConfig {
  const cfg: OsvConfig = { ...DEFAULTS };
  const posInt = (k: "page_size" | "max_pages" | "backfill_days" | "max_csv_rows") => {
    if (raw[k] === undefined) return;
    const v = raw[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`osv config: ${k} must be a positive integer`);
    cfg[k] = v;
  };
  const strList = (k: "ecosystems" | "skip_id_prefixes", allowEmpty: boolean) => {
    if (raw[k] === undefined) return;
    const v = raw[k];
    if (!Array.isArray(v) || (!allowEmpty && v.length === 0) || !v.every((x) => typeof x === "string" && x !== "")) {
      throw new Error(`osv config: ${k} must be a list of strings`);
    }
    cfg[k] = v as string[];
  };
  const url = (k: "csv_base" | "api_base") => {
    if (raw[k] === undefined) return;
    const v = raw[k];
    if (typeof v !== "string" || !/^https?:\/\//.test(v)) throw new Error(`osv config: ${k} must be an http(s) URL`);
    cfg[k] = v.replace(/\/+$/, "");
  };
  posInt("page_size");
  posInt("max_pages");
  posInt("backfill_days");
  posInt("max_csv_rows");
  strList("ecosystems", false);
  strList("skip_id_prefixes", true);
  url("csv_base");
  url("api_base");
  return cfg;
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const cfg = readConfig(ctx.source.config);
  const kv = ctx.env.CURSORS;
  const stored = await kv.get(CURSOR_KEY);
  const since = stored ?? new Date(ctx.now().getTime() - cfg.backfill_days * 86_400_000).toISOString();
  const sinceKey = modKey(since);

  // Merge every ecosystem list; an id in two lists keeps its newest modified.
  const latest = new Map<string, ModifiedRow>();
  for (const eco of cfg.ecosystems) {
    const rows = await listModifiedSince(ctx.fetch, cfg.csv_base, eco, sinceKey, cfg.max_csv_rows, modKey);
    for (const row of rows) {
      if (cfg.skip_id_prefixes.some((p) => row.id.startsWith(p))) continue;
      const prev = latest.get(row.id);
      if (!prev || modKey(row.modified) > modKey(prev.modified)) latest.set(row.id, row);
    }
  }
  const sorted = [...latest.values()].sort((a, b) => {
    const ka = modKey(a.modified);
    const kb = modKey(b.modified);
    return ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const result: RunResult = { fetched: 0, upserted: 0, unchanged: 0, errors: [] };
  for (const page of paginate(sorted, cfg.page_size).slice(0, cfg.max_pages)) {
    for (const row of page) {
      // HTTP and D1 errors throw out of the run: this page's cursor is not written.
      const vuln = (await getVuln(ctx.fetch, cfg.api_base, row.id)) as OsvVuln;
      result.fetched += 1;
      const norm = normalizeOsv(vuln, cfg.ecosystems);
      if (!norm.ok) {
        // A permanent data problem: record it and let the page complete.
        result.errors.push(`${row.id}: ${norm.reason}`);
        continue;
      }
      // One advisory per package; an invalid doc does not stop the others.
      for (const d of norm.docs) {
        try {
          const outcome = await upsertAdvisory(ctx.env.DB, d.doc, { source: "osv", source_id: d.source_id });
          if (outcome === "unchanged") result.unchanged += 1;
          else result.upserted += 1;
        } catch (err) {
          if (!(err instanceof InvalidAdvisoryError)) throw err;
          result.errors.push(`${d.source_id}: ${err.message}`);
        }
      }
    }
    await kv.put(CURSOR_KEY, page[page.length - 1].modified);
  }
  return result;
}

export const osv: Ingester = { id: "osv", run };
