// Runtime ingesters over a runtime's own GitHub repository security
// advisories (deno-runtime, bun-runtime). The pure part turns one GHSA object
// into an advisory; githubRuntimeIngester builds the run for one runtime.
import { compareSemver } from "../check/match/semver";
import type { AffectedRange, SeverityLabel } from "../schema/advisory";
import { markCoverage } from "./coverage";
import { advisoriesPageUrl, fetchAdvisoryPage, fetchReleasePage, releasesPageUrl } from "./github-advisories";
import { oneLine, readRuntimeConfig } from "./runtime-text";
import type { AdvisoryInput, IngestContext, Ingester, RunResult } from "./types";
import { InvalidAdvisoryError, upsertAdvisory } from "./upsert";

export interface GithubRuntimeDefaults extends Record<string, string | number> {
  advisories_url: string;
  releases_url: string;
  release_tag_prefix: string;
  exclude_package_pattern: string;
  page_size: number;
  max_pages: number;
  release_page_size: number;
  max_release_pages: number;
}

export const cursorKey = (source: string) => `cursor:${source}`;
export const etagKey = (source: string) => `${source}:etag`;

// Dedup before the releases read: PK seek on advisory_sources (source, source_id).
export const RELEASE_DEDUP_SQL = "SELECT 1 AS hit FROM advisory_sources WHERE source = ? AND source_id = ?";

const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const CVE = /^CVE-\d{4}-\d{4,}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const LABELS: Record<string, SeverityLabel> = { critical: "critical", high: "high", medium: "medium", moderate: "medium", low: "low" };

export interface NormalizeOptions {
  runtime: string;
  source: string;
  excludePackage: RegExp;
  released?: Set<string>;
}

export type NormalizeResult =
  | { ok: true; doc: AdvisoryInput }
  | { ok: false; needsReleases: true; reason: string }
  // Terminal: "skip" (not a published runtime advisory) or "no_fix" (no fixed version can be derived).
  | { ok: false; code: "skip" | "no_fix"; reason: string };

// "1.9" -> "1.9.0", "2" -> "2.0.0".
function pad(v: string): string {
  const parts = v.split(".");
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
}

const lineOf = (v: string) => v.split(".").slice(0, 2).join(".");

function sortVersions(vs: Iterable<string>): string[] {
  return [...new Set(vs)].sort(compareSemver);
}

export interface RangeBounds {
  lower: string;
  lt: string[];
  le: string[];
}

// Parses a GitHub `vulnerable_version_range`: comparators with an optional
// `v`, separated by spaces or commas, or the form `A - B`.
export function parseRangeBounds(range: string): RangeBounds {
  const hyphen = /^\s*v?(\d+(?:\.\d+){0,2})\s+-\s+v?(\d+(?:\.\d+){0,2})\s*$/.exec(range);
  if (hyphen) return { lower: pad(hyphen[1]), lt: [], le: [pad(hyphen[2])] };
  const lowers: string[] = [];
  const lt: string[] = [];
  const le: string[] = [];
  for (const m of range.matchAll(/(<=|>=|<|>|=)?\s*v?(\d+(?:\.\d+){0,2})/g)) {
    const v = pad(m[2]);
    const op = m[1];
    if (op === "<") lt.push(v);
    else if (op === "<=") le.push(v);
    else if (op === ">") {
      const [a, b, c] = v.split(".").map(Number);
      lowers.push(`${a}.${b}.${c + 1}`);
    } else lowers.push(v);
  }
  return { lower: lowers.length === 0 ? "0" : sortVersions(lowers)[0], lt, le };
}

// The fixed versions from `patched_versions` (authoritative), plus each `< X`
// bound on a release line that no patched version covers. An empty patched
// list gives no fix here: the caller takes the fix from the released versions.
export function fixesFrom(patched: string, lt: string[]): string[] {
  const fixes = patched
    .split(",")
    .map((p) => p.replace(/>=|v|\s/g, ""))
    .filter((p) => p !== "")
    .map(pad)
    .filter((p) => /^\d+\.\d+\.\d+$/.test(p));
  if (fixes.length === 0) return [];
  const lines = new Set(fixes.map(lineOf));
  return sortVersions([...fixes, ...lt.filter((x) => !lines.has(lineOf(x)))]);
}

// One range per fix, lowest first. Range i>1 starts at the release line after
// fix i-1, so "2.2.15, 2.5.2" leaves 2.2.16 unaffected and 2.3.4 affected.
export function rangesFor(lower: string, fixes: string[]): AffectedRange[] {
  // One fix per release line: the lowest.
  const perLine = new Map<string, string>();
  for (const f of sortVersions(fixes)) if (!perLine.has(lineOf(f))) perLine.set(lineOf(f), f);
  const fs = [...perLine.values()];
  return fs.map((fixed, i) => {
    if (i === 0) return { introduced: lower !== "0" && compareSemver(lower, fixed) < 0 ? lower : "0", fixed };
    const [a, b] = fs[i - 1].split(".").map(Number);
    return { introduced: `${a}.${b + 1}.0`, fixed };
  });
}

function fixesFromReleases(b: RangeBounds, released: Set<string>): string[] {
  const out = b.lt.filter((x) => released.has(x));
  if (out.length > 0) return out;
  const sorted = sortVersions(released);
  return b.le.flatMap((x) => {
    const above = sorted.find((r) => compareSemver(r, x) > 0);
    return above === undefined ? [] : [above];
  });
}

function actionFor(runtime: string, fixes: string[]): string {
  if (fixes.length === 1) return `Upgrade ${runtime} to ${fixes[0]} or later.`;
  const parts = fixes.slice(0, -1).map((f) => `${f} (${lineOf(f)}.x)`);
  const text = `Upgrade ${runtime} to ${parts.join(", ")} or ${fixes[fixes.length - 1]} or later.`;
  return text.length <= 200 ? text : `Upgrade ${runtime} to ${fixes[0]} or later.`;
}

// GitHub sends `score: 0.0` with `vector_string: null` when a CVSS version is
// absent, so a score counts only next to a vector.
function scoreOf(cvss: unknown): number | undefined {
  for (const k of ["cvss_v4", "cvss_v3"]) {
    const c = (cvss as Record<string, { vector_string?: unknown; score?: unknown } | undefined> | null)?.[k];
    if (c && typeof c.vector_string === "string" && c.vector_string !== "" && typeof c.score === "number" && c.score >= 0 && c.score <= 10) return c.score;
  }
  return undefined;
}

const str = (x: unknown) => (typeof x === "string" ? x : undefined);
const skip = (reason: string): NormalizeResult => ({ ok: false, code: "skip", reason });

export function normalizeGithubRuntimeAdvisory(raw: unknown, opts: NormalizeOptions): NormalizeResult {
  if (raw === null || typeof raw !== "object") return skip("not an object");
  const g = raw as Record<string, unknown>;
  const ghsa = str(g.ghsa_id);
  if (ghsa === undefined || !GHSA.test(ghsa)) return skip(`bad ghsa_id ${JSON.stringify(g.ghsa_id)}`);
  if (g.state !== "published") return skip(`state ${String(g.state)}`);
  if (g.withdrawn_at !== null && g.withdrawn_at !== undefined) return skip("withdrawn");
  const htmlUrl = str(g.html_url);
  if (htmlUrl === undefined || !/^https?:\/\//.test(htmlUrl)) return skip("no html_url");
  const published = str(g.published_at);
  if (published === undefined || !ISO.test(published)) return skip("no published_at");
  const updated = str(g.updated_at);

  // The repo is the runtime's own, so the package ecosystem is ignored; only library crates drop out.
  const entries = (Array.isArray(g.vulnerabilities) ? g.vulnerabilities : []).filter((v) => {
    const name = (v as { package?: { name?: unknown } } | null)?.package?.name;
    return typeof name !== "string" || !opts.excludePackage.test(name);
  }) as { vulnerable_version_range?: unknown; patched_versions?: unknown }[];
  if (entries.length === 0) return skip(`no ${opts.runtime} package entry`);

  const affected: AffectedRange[] = [];
  const fixedAll: string[] = [];
  let needsReleases = false;
  for (const e of entries) {
    const bounds = parseRangeBounds(str(e.vulnerable_version_range) ?? "");
    let fixes = fixesFrom(str(e.patched_versions) ?? "", bounds.lt);
    if (fixes.length === 0 && (bounds.lt.length > 0 || bounds.le.length > 0)) {
      if (opts.released === undefined) {
        needsReleases = true;
        continue;
      }
      fixes = fixesFromReleases(bounds, opts.released);
    }
    // An entry with no derivable fix adds nothing (iron rule 10: no guessed range).
    for (const r of rangesFor(bounds.lower, fixes)) {
      if (!affected.some((a) => a.introduced === r.introduced && a.fixed === r.fixed)) affected.push(r);
      fixedAll.push(r.fixed!);
    }
  }
  if (needsReleases) return { ok: false, needsReleases: true, reason: `${ghsa}: no patched version` };
  if (affected.length === 0) return { ok: false, code: "no_fix", reason: `no fixed ${opts.runtime} version` };

  affected.sort((a, b) => compareSemver(a.fixed!, b.fixed!));
  const fixed_versions = sortVersions(fixedAll);
  const cve = str(g.cve_id);
  const cve_ids = cve !== undefined && CVE.test(cve) ? [cve] : [];
  const label = typeof g.severity === "string" ? (LABELS[g.severity.toLowerCase()] ?? "unknown") : "unknown";
  const score = scoreOf(g.cvss_severities);
  const summary = oneLine(str(g.summary) ?? "") || cve_ids[0] || ghsa;
  return {
    ok: true,
    doc: {
      cve_ids,
      ghsa_id: ghsa,
      ecosystem: opts.runtime,
      component: opts.runtime,
      affected,
      fixed_versions,
      severity: score === undefined ? { label } : { score, label },
      exploited: false,
      published_at: published,
      modified_at: updated !== undefined && ISO.test(updated) ? updated : published,
      summary,
      action: actionFor(opts.runtime, fixed_versions),
      references: [htmlUrl, ...cve_ids.map((c) => `https://www.cve.org/CVERecord?id=${c}`)],
      sources: [{ source: opts.source, source_id: ghsa, url: htmlUrl }],
    },
  };
}

// The versions of the non-draft, non-prerelease releases whose tag is `<prefix>X.Y.Z`.
export function parseReleaseTags(body: unknown[], prefix: string): string[] {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+\\.\\d+\\.\\d+)$`);
  const out: string[] = [];
  for (const r of body) {
    const x = r as { tag_name?: unknown; draft?: unknown; prerelease?: unknown } | null;
    if (!x || x.draft !== false || x.prerelease !== false || typeof x.tag_name !== "string") continue;
    const m = re.exec(x.tag_name);
    if (m) out.push(m[1]);
  }
  return out;
}

export function githubRuntimeIngester(source: string, runtime: string, defaults: GithubRuntimeDefaults): Ingester {
  async function run(ctx: IngestContext): Promise<RunResult> {
    const cfg = readRuntimeConfig(source, ctx.source.config, defaults);
    let excludePackage: RegExp;
    try {
      excludePackage = new RegExp(cfg.exclude_package_pattern);
    } catch {
      throw new Error(`${source} config: exclude_package_pattern must be a valid regular expression`);
    }
    const token = ctx.env.GITHUB_TOKEN;
    const kv = ctx.env.CURSORS;
    // No coverage_since yet (TCS-32): read the whole history once, with no
    // cursor and no ETag. The upserts are idempotent, so a re-read writes
    // nothing new. A complete run then sets coverage_since.
    const fullRead = ctx.source.coverage_since === null;
    const storedCursor = await kv.get(cursorKey(source));
    const stored = fullRead ? null : storedCursor;
    const storedEtag = fullRead ? null : await kv.get(etagKey(source));
    const result: RunResult = { fetched: 0, upserted: 0, unchanged: 0, errors: [] };
    const origin = new URL(cfg.advisories_url).origin;

    // Read pages, newest first, until an item is older than the cursor.
    const items: { raw: unknown; published: string }[] = [];
    let url: string | undefined = advisoriesPageUrl(cfg.advisories_url, cfg.page_size);
    let firstEtag: string | undefined;
    let pages = 0;
    let capped = false;
    while (url !== undefined) {
      const page = await fetchAdvisoryPage(ctx.fetch, url, token, origin, pages === 0 ? (storedEtag ?? undefined) : undefined);
      // Nothing changed upstream since the stored ETag: no write (dedup before spend).
      if (page.notModified) return result;
      if (pages === 0) firstEtag = page.etag;
      pages += 1;
      let older = false;
      for (const raw of page.body) {
        const p = (raw as { published_at?: unknown } | null)?.published_at;
        const published = typeof p === "string" ? p : "";
        // Strictly older: an item at the cursor is read again and comes back unchanged.
        if (stored !== null && published < stored) {
          older = true;
          break;
        }
        items.push({ raw, published });
      }
      if (older || page.next === undefined) break;
      if (pages >= cfg.max_pages) {
        capped = true;
        break;
      }
      url = page.next;
    }

    let released: Set<string> | undefined;
    let releasesComplete = true;
    const loadReleases = async (): Promise<Set<string>> => {
      if (released) return released;
      const relOrigin = new URL(cfg.releases_url).origin;
      const versions: string[] = [];
      let next: string | undefined = releasesPageUrl(cfg.releases_url, cfg.release_page_size);
      for (let n = 0; next !== undefined; n++) {
        if (n >= cfg.max_release_pages) {
          releasesComplete = false;
          break;
        }
        const page = await fetchReleasePage(ctx.fetch, next, token, relOrigin);
        versions.push(...parseReleaseTags(page.body, cfg.release_tag_prefix));
        next = page.next;
      }
      released = new Set(versions);
      return released;
    };

    items.sort((a, b) => (a.published < b.published ? -1 : a.published > b.published ? 1 : 0));
    const opts: NormalizeOptions = { runtime, source, excludePackage };
    for (const item of items) {
      result.fetched += 1;
      let norm = normalizeGithubRuntimeAdvisory(item.raw, opts);
      if (!norm.ok && "needsReleases" in norm) {
        const ghsa = String((item.raw as { ghsa_id?: unknown }).ghsa_id);
        // Already stored: skip the metered releases read.
        const hit = await ctx.env.DB.prepare(RELEASE_DEDUP_SQL).bind(source, ghsa).first();
        if (hit) {
          result.unchanged += 1;
          continue;
        }
        norm = normalizeGithubRuntimeAdvisory(item.raw, { ...opts, released: await loadReleases() });
      }
      if (norm.ok) {
        try {
          const outcome = await upsertAdvisory(ctx.env.DB, norm.doc, { source, source_id: norm.doc.sources[0].source_id });
          if (outcome === "unchanged") result.unchanged += 1;
          else result.upserted += 1;
        } catch (err) {
          if (!(err instanceof InvalidAdvisoryError)) throw err;
          result.errors.push(`${norm.doc.sources[0].source_id}: ${err.message}`);
        }
        continue;
      }
      const ghsa = String((item.raw as { ghsa_id?: unknown } | null)?.ghsa_id ?? "?");
      const reason = "reason" in norm ? norm.reason : "";
      if ("code" in norm && norm.code === "no_fix" && !releasesComplete) {
        // The release list was cut at max_release_pages: "no fix" is not proven.
        result.errors.push(`${ghsa}: ${reason}; releases read stopped at ${cfg.max_release_pages} pages`);
      } else {
        (result.warnings ??= []).push(`${ghsa}: ${reason}`);
      }
    }

    if (capped) {
      result.incomplete = true;
      result.errors.push(`more than ${cfg.max_pages} pages of advisories; cursor not moved`);
    }
    // KV moves only after a complete run with no record error, so nothing is skipped silently.
    if (result.errors.length > 0) return result;
    // The cursor never moves back, also after a full read.
    const newest = items.reduce<string | null>((m, i) => (i.published !== "" && (m === null || i.published > m) ? i.published : m), storedCursor);
    if (newest !== null && newest !== storedCursor) await kv.put(cursorKey(source), newest);
    if (firstEtag !== undefined) await kv.put(etagKey(source), firstEtag);
    else await kv.delete(etagKey(source));
    if (fullRead) await markCoverage(ctx.env.DB, source, ctx.now().toISOString());
    return result;
  }
  return { id: source, run };
}
