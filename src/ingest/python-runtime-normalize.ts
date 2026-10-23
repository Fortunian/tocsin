// Pure parsers and the normalizer for the python-runtime ingester. No I/O.
// A PSF advisory record (OSV format, GIT commit ranges only) names the CVE;
// the PSF CVE record (CVE JSON 5) gives the affected range per release line.
import { comparePep440 } from "../check/match/pep440";
import type { SeverityLabel } from "../schema/advisory";
import { isoUtc, oneLine } from "./runtime-text";
import type { AdvisoryInput } from "./types";

const SOURCE = "python-runtime";
export const PSF_ID = /^PSF-(\d{4})-(\d+)$/;
const CVE_ID = /^CVE-\d{4}-\d{4,}$/;
const FINAL = /^(\d+)\.(\d+)\.\d+$/;
const LABELS: Record<string, SeverityLabel> = { critical: "critical", high: "high", medium: "medium", low: "low" };
const METRIC_KEYS = ["cvssV4_0", "cvssV3_1", "cvssV3_0"] as const;

export type PyNormalizeResult = { ok: true; doc: AdvisoryInput } | { ok: false; error: boolean; reason: string };
type Fail = Extract<PyNormalizeResult, { ok: false }>;

export interface PyNormalizeOptions {
  minLine: string;
  htmlBase: string;
}

interface PsfFacts {
  ok: true;
  cve: string;
  published?: string;
  modified?: string;
  details: string;
  advisoryUrls: string[];
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const fail = (reason: string, error = true): Fail => ({ ok: false, error, reason });

/** -1, 0 or 1 for two PSF ids in (year, number) order. */
export function comparePsfIds(a: string, b: string): number {
  const x = PSF_ID.exec(a);
  const y = PSF_ID.exec(b);
  if (!x || !y) throw new Error(`not a PSF id: ${x ? b : a}`);
  return Math.sign(Number(x[1]) - Number(y[1]) || Number(x[2]) - Number(y[2]));
}

/** The PSF ids in a GitHub contents listing of advisories/python, in (year, number) order. */
export function parsePsfListing(body: unknown): string[] {
  if (!Array.isArray(body)) throw new Error("PSF listing is not a JSON array");
  const ids = new Set<string>();
  for (const e of body) {
    const name = isObj(e) && e.type === "file" ? str(e.name) : undefined;
    const id = name?.endsWith(".json") ? name.slice(0, -5) : undefined;
    if (id !== undefined && PSF_ID.test(id)) ids.add(id);
  }
  return [...ids].sort(comparePsfIds);
}

/** The final versions ("3.14.9") among CPython tag refs: `refs/tags/v3.14.9`; a1, b1, rc1 tags are skipped. */
export function parseCpythonTags(body: unknown): Set<string> {
  if (!Array.isArray(body)) throw new Error("CPython tag refs answer is not a JSON array");
  const out = new Set<string>();
  for (const r of body) {
    const m = /^refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(isObj(r) ? (str(r.ref) ?? "") : "");
    if (m) out.add(m[1]);
  }
  return out;
}

/** The final versions ("3.14.9") of the published python.org releases. */
export function parsePythonReleases(body: unknown): Set<string> {
  if (!Array.isArray(body)) throw new Error("python.org releases answer is not a JSON array");
  const out = new Set<string>();
  for (const r of body) {
    if (!isObj(r) || r.is_published !== true || r.pre_release === true) continue;
    const m = /^Python (\d+\.\d+\.\d+)$/.exec(str(r.name) ?? "");
    if (m) out.add(m[1]);
  }
  return out;
}

/** The CVE a PSF record names, or why it yields no advisory. */
export function readPsf(psfId: string, raw: unknown): PsfFacts | Fail {
  if (!isObj(raw)) return fail(`${psfId}: record is not a JSON object`);
  if (raw.id !== psfId) return fail(`${psfId}: record id is ${String(raw.id)}`);
  if (raw.withdrawn != null) return fail(`${psfId}: withdrawn`, false);
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === "string" && CVE_ID.test(a)) : [];
  if (aliases.length === 0) return fail(`${psfId}: no CVE alias`);
  const refs = Array.isArray(raw.references) ? raw.references.filter(isObj) : [];
  const advisoryUrls = refs.filter((r) => r.type === "ADVISORY").flatMap((r) => (/^https?:\/\//.test(str(r.url) ?? "") ? [r.url as string] : []));
  const date = (x: unknown) => (typeof x === "string" ? isoUtc(x) : undefined);
  return { ok: true, cve: aliases[0], published: date(raw.published), modified: date(raw.modified), details: str(raw.details) ?? "", advisoryUrls };
}

interface LineRange {
  line: string;
  introduced: string;
  fixed: string;
}

function lineAtLeast(line: string, min: string): boolean {
  const [a, b] = line.split(".").map(Number);
  const [c, d] = min.split(".").map(Number);
  return a !== c ? a > c : b >= d;
}

/** One range per release line from a CVE record's CPython `affected` entries. Pre-release fixes are dropped. */
export function lineRanges(affected: unknown[], minLine: string): LineRange[] {
  const byLine = new Map<string, LineRange>();
  for (const a of affected.filter(isObj)) {
    if (!/^cpython$/i.test(str(a.product) ?? "") || !Array.isArray(a.versions)) continue;
    for (const v of a.versions.filter(isObj)) {
      const fixed = str(v.lessThan);
      const introduced = str(v.version);
      const m = fixed === undefined ? null : FINAL.exec(fixed);
      if (v.status !== "affected" || !m || introduced === undefined || !(introduced === "0" || FINAL.test(introduced))) continue;
      const line = `${m[1]}.${m[2]}`;
      if (lineAtLeast(line, minLine) && !byLine.has(line)) byLine.set(line, { line, introduced, fixed: fixed! });
    }
  }
  return [...byLine.values()].sort((x, y) => comparePep440(x.fixed, y.fixed));
}

function severityOf(metrics: unknown): AdvisoryInput["severity"] {
  for (const key of METRIC_KEYS) {
    for (const m of Array.isArray(metrics) ? metrics.filter(isObj) : []) {
      const c = m[key];
      if (!isObj(c) || typeof c.baseScore !== "number" || c.baseScore < 0 || c.baseScore > 10) continue;
      return { score: c.baseScore, label: LABELS[(str(c.baseSeverity) ?? "").toLowerCase()] ?? "unknown" };
    }
  }
  return { label: "unknown" };
}

function summaryOf(cna: Obj, details: string): string {
  const en = Array.isArray(cna.descriptions) ? cna.descriptions.filter(isObj).find((d) => d.lang === "en") : undefined;
  return oneLine(str(cna.title) ?? "") || oneLine(str(en?.value) ?? "") || oneLine(details.split("\n")[0] ?? "");
}

// "Upgrade python to 3.12.15 (3.12.x) or 3.14.9 (3.14.x) or later."
function actionFor(lines: LineRange[]): string {
  if (lines.length === 1) return `Upgrade python to ${lines[0].fixed} or later.`;
  const parts = lines.map((l) => `${l.fixed} (${l.line}.x)`);
  const text = `Upgrade python to ${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]} or later.`;
  return text.length <= 200 ? text : `Upgrade python to ${lines[0].fixed} or later.`;
}

const lineOf = (fixed: string): string => fixed.split(".").slice(0, 2).join(".");

// " The 3.14.x fix (3.14.9) is not released yet." for each pending line.
function pendingTail(pendingFixed: string[]): string {
  if (pendingFixed.length === 0) return "";
  if (pendingFixed.length === 1) return `The ${lineOf(pendingFixed[0])}.x fix (${pendingFixed[0]}) is not released yet.`;
  return `The fixes for ${pendingFixed.map((f) => `${lineOf(f)}.x (${f})`).join(", ")} are not released yet.`;
}

/**
 * The advisory to publish: every affected range from the CVE record, always.
 * Only the action changes while a fix is not on python.org: it names the
 * released lines and states each unreleased fix. `quiet` lines (unreleased
 * past the pending window) leave the action without a note.
 */
export function publishedDoc(full: AdvisoryInput, pendingFixed: string[], quiet: string[]): AdvisoryInput {
  const all = full.affected.map((r) => ({ line: lineOf(r.fixed!), introduced: r.introduced!, fixed: r.fixed! }));
  const released = all.filter((l) => !pendingFixed.includes(l.fixed) && !quiet.includes(l.fixed));
  const tail = pendingTail(pendingFixed);
  let action = released.length > 0 ? actionFor(released) : tail === "" ? actionFor(all) : "";
  if (tail !== "" && (action === "" || action.length + 1 + tail.length <= 200)) action = action === "" ? tail : `${action} ${tail}`;
  return { ...full, action: action.slice(0, 200) };
}

function readCna(psfId: string, cve: string, raw: unknown): { ok: true; cna: Obj; published?: string } | Fail {
  const meta = isObj(raw) && isObj(raw.cveMetadata) ? raw.cveMetadata : undefined;
  if (!meta || meta.cveId !== cve) return fail(`${psfId}: CVE record is not for ${cve}`);
  if (meta.state === "REJECTED") return fail(`${psfId}: ${cve} is rejected`, false);
  const cna = isObj(raw) && isObj(raw.containers) && isObj(raw.containers.cna) ? raw.containers.cna : undefined;
  if (meta.state !== "PUBLISHED" || !cna) return fail(`${psfId}: ${cve} record has no published CNA container`);
  const published = typeof meta.datePublished === "string" ? isoUtc(meta.datePublished) : undefined;
  return published === undefined ? { ok: true, cna } : { ok: true, cna, published };
}

export function normalizePythonAdvisory(psfId: string, psfRaw: unknown, cveRaw: unknown, opts: PyNormalizeOptions): PyNormalizeResult {
  const psf = readPsf(psfId, psfRaw);
  if (!psf.ok) return psf;
  const rec = readCna(psfId, psf.cve, cveRaw);
  if (!rec.ok) return rec;
  const lines = lineRanges(Array.isArray(rec.cna.affected) ? rec.cna.affected : [], opts.minLine);
  if (lines.length === 0) return fail(`${psfId}: no release line ${opts.minLine} or newer with a final fixed version`, false);
  const published_at = psf.published ?? rec.published;
  if (published_at === undefined) return fail(`${psfId}: no published date`);
  const html = `${opts.htmlBase}/${psfId}.json`;
  return {
    ok: true,
    doc: {
      cve_ids: [psf.cve],
      ecosystem: "python",
      component: "python",
      affected: lines.map((l) => ({ introduced: l.introduced, fixed: l.fixed })),
      fixed_versions: lines.map((l) => l.fixed),
      severity: severityOf(rec.cna.metrics),
      exploited: false,
      published_at,
      modified_at: psf.modified ?? published_at,
      summary: summaryOf(rec.cna, psf.details) || `${psf.cve} in CPython`,
      action: actionFor(lines),
      references: [...new Set([html, ...psf.advisoryUrls, `https://www.cve.org/CVERecord?id=${psf.cve}`])],
      sources: [{ source: SOURCE, source_id: psfId, url: html }],
    },
  };
}
