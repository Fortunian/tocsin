// The php-runtime ingester: lists the php-src GitHub security advisories
// (GHSA) newest first, down to the KV cursor (the newest published_at read),
// and emits one advisory per GHSA CVE. The GHSA gives the patched versions and
// the CVSS score. The php.net news page is the second source: a "Security
// advisory" post that links the GHSA gives the post link, the "no longer
// receive updates" line, and the "Update to PHP ..." fixed versions when the
// GHSA has no patched_versions. The php.net releases feed confirms each fixed
// version is released.
import { advisoriesPageUrl } from "./github-advisories";
import { compareVersions } from "./osv";
import { fetchGhsaListPage, fetchNews, fetchReleases } from "./php-runtime-client";
import { decodeEntities, htmlText, isoUtc, oneLine, readRuntimeConfig, readSince, xmlBlocks } from "./runtime-text";
import type { AdvisoryInput, IngestContext, Ingester, RunResult } from "./types";
import { InvalidAdvisoryError, upsertAdvisory } from "./upsert";
import type { SeverityLabel } from "../schema/advisory";

export const PHP_CURSOR_KEY = "cursor:php-runtime";
const SOURCE = "php-runtime";

// Dedup before the php.net news and releases reads: one seek on the advisory_sources primary key.
export const PHP_DEDUP_SQL = "SELECT 1 AS hit FROM advisory_sources WHERE source = ? AND source_id = ?";

// Code fallbacks for sources.config_json of row "php-runtime" (repo iron rule 5).
export const PHP_DEFAULTS = {
  news_url: "https://www.php.net/index.php",
  releases_url: "https://www.php.net/releases/feed.php",
  ghsa_api_base: "https://api.github.com/repos/php/php-src/security-advisories",
  title_match: "Security advisory",
  backfill_days: 120,
  max_posts: 5,
  // Most advisories one run reads at or after the cursor; more throws (knob: sources.config_json of row "php-runtime").
  max_advisories: 50,
  // per_page of the advisories list; 100 is the GitHub maximum (knob: sources.config_json of row "php-runtime").
  page_size: 100,
};

export interface NewsEntry {
  title: string;
  link: string;
  published: string;
  content: string;
}

export interface CvePair {
  cve: string;
  ghsa: string;
}

export interface ParsedPhpPost {
  pairs: CvePair[];
  // "8.1" when the post says "PHP 8.1 and older no longer receive updates".
  noFixLine?: string;
}

// What a php.net post that links a GHSA adds to it.
interface PostFacts {
  entry: NewsEntry;
  pair: CvePair;
  noFixLine?: string;
  fixedVersions: string[];
}

export type PhpNormalizeResult = { ok: true; doc: AdvisoryInput } | { ok: false; reason: string; incomplete: boolean };

interface Ghsa {
  ghsa_id?: unknown;
  cve_id?: unknown;
  html_url?: unknown;
  summary?: unknown;
  severity?: unknown;
  state?: unknown;
  withdrawn_at?: unknown;
  published_at?: unknown;
  updated_at?: unknown;
  vulnerabilities?: { patched_versions?: unknown; vulnerable_version_range?: unknown }[];
  cvss_severities?: { cvss_v4?: { score?: unknown }; cvss_v3?: { score?: unknown } };
}

const CVE = /CVE-\d{4}-\d{4,}/;
const GHSA_LINK = /\/security\/advisories\/(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})\b/;
const NO_FIX = /<strong>\s*PHP (\d+\.\d+) and older\s*<\/strong>\s*no longer receive updates/i;
// "Update to PHP 8.5.12, 8.4.27, 8.3.36 or 8.2.35": X.Y.Z versions only, so
// "8.6.0RC3" or "8.5" never match.
const VERSION = String.raw`\d+\.\d+\.\d+(?![\w-]|\.\w)`;
const FIX_SENTENCE = new RegExp(String.raw`Update to PHP (${VERSION}(?:, ${VERSION})*(?:,? (?:or|and) ${VERSION})?)`);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const LABELS: Record<string, SeverityLabel> = { critical: "critical", high: "high", moderate: "medium", medium: "medium", low: "low" };

export function parsePhpNews(html: string): NewsEntry[] {
  const out: NewsEntry[] = [];
  for (const m of html.matchAll(/<article\b[^>]*class="[^"]*\bnewsentry\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi)) {
    const block = m[1];
    const time = /<time\b[^>]*datetime="([^"]+)"/i.exec(block);
    const title = /<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const published = time ? isoUtc(time[1]) : undefined;
    if (!published || !title) continue;
    const link = decodeEntities(title[1]);
    if (!/^https?:\/\//.test(link)) continue;
    const headerEnd = block.search(/<\/header>/i);
    out.push({ title: htmlText(title[2]), link, published, content: headerEnd === -1 ? block : block.slice(headerEnd) });
  }
  return out;
}

export function parsePhpPost(content: string): ParsedPhpPost {
  const pairs: CvePair[] = [];
  for (const li of content.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const cve = CVE.exec(li[1]);
    const ghsa = GHSA_LINK.exec(li[1]);
    if (cve && ghsa && !pairs.some((p) => p.cve === cve[0])) pairs.push({ cve: cve[0], ghsa: ghsa[1] });
  }
  const noFix = NO_FIX.exec(content);
  return noFix ? { pairs, noFixLine: noFix[1] } : { pairs };
}

// The fixed versions of the post's "Update to PHP ..." sentence, in source order, or [].
export function parsePhpFixSentence(content: string): string[] {
  const m = FIX_SENTENCE.exec(htmlText(content));
  return m ? m[1].split(/,? (?:or|and) |, /) : [];
}

export function parsePhpReleases(xml: string): Set<string> {
  return new Set(xmlBlocks(xml, "php:version").map((v) => v.trim()));
}

function scoreOf(g: Ghsa): number | undefined {
  for (const s of [g.cvss_severities?.cvss_v4?.score, g.cvss_severities?.cvss_v3?.score]) {
    if (typeof s === "number" && s >= 0 && s <= 10) return s;
  }
  return undefined;
}

// True for a GHSA range with an upper bound and no lower bound ("< 8.2.35"):
// every version below the fix is vulnerable, older unsupported lines included.
function opensFromZero(range: string | undefined): boolean {
  return range !== undefined && /</.test(range) && !/>/.test(range);
}

function actionFor(perLine: { line: string; fixed: string }[], noFixLine: string | undefined): string {
  const tail = noFixLine === undefined ? "" : ` Unsupported lines (${noFixLine} and older) get no fix.`;
  if (perLine.length === 1) return `Upgrade php to ${perLine[0].fixed} or later.${tail}`;
  const parts = perLine.map((p) => `${p.fixed} (${p.line})`);
  const text = `Upgrade php to ${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]} or later.${tail}`;
  return text.length <= 200 ? text : `Upgrade php to ${perLine[0].fixed} or later.${tail}`;
}

// `entry` is the php.net post that links the GHSA, if any. `fallbackFixed` is
// that post's "Update to PHP ..." versions, used only when the GHSA has no
// patched_versions.
export function normalizePhpAdvisory(
  entry: Pick<NewsEntry, "title" | "link" | "published"> | undefined,
  pair: CvePair,
  raw: unknown,
  noFixLine: string | undefined,
  released: Set<string>,
  fallbackFixed: string[] = [],
): PhpNormalizeResult {
  const fail = (reason: string, incomplete = false): PhpNormalizeResult => ({ ok: false, reason: `${pair.cve} (${pair.ghsa}): ${reason}`, incomplete });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("GHSA answer is not an object");
  const g = raw as Ghsa;
  if (g.ghsa_id !== pair.ghsa) return fail(`GHSA answer is for ${String(g.ghsa_id)}`);
  if (g.state !== "published" || g.withdrawn_at != null) return fail(`GHSA state is ${String(g.state)}${g.withdrawn_at != null ? ", withdrawn" : ""}`);
  if (typeof g.cve_id === "string" && g.cve_id !== pair.cve) return fail(`GHSA names ${g.cve_id}, the post names ${pair.cve}`);

  const fixed = new Set<string>();
  // Patched version -> the GHSA vulnerable_version_range of its entry.
  const rangeOf = new Map<string, string>();
  for (const v of Array.isArray(g.vulnerabilities) ? g.vulnerabilities : []) {
    if (typeof v?.patched_versions !== "string") continue;
    for (const p of v.patched_versions.split(",")) {
      if (p.trim() === "") continue;
      fixed.add(p.trim());
      if (typeof v.vulnerable_version_range === "string") rangeOf.set(p.trim(), v.vulnerable_version_range);
    }
  }
  if (fixed.size === 0) for (const v of fallbackFixed) fixed.add(v);
  // Incomplete: a later php.net post or GHSA edit can give the fix, so it is read again.
  if (fixed.size === 0) return fail("GHSA has no patched version", true);
  const sorted = [...fixed].sort(compareVersions);
  const perLine: { line: string; fixed: string }[] = [];
  for (const v of sorted) {
    const m = /^(\d+)\.(\d+)\.\d+$/.exec(v);
    if (!m) return fail(`unexpected patched version ${v}`);
    perLine.push({ line: `${m[1]}.${m[2]}`, fixed: v });
  }
  const unreleased = sorted.filter((v) => !released.has(v));
  if (unreleased.length > 0) return fail(`patched version ${unreleased.join(", ")} not in the php.net releases feed yet`, true);

  const score = scoreOf(g);
  const label = typeof g.severity === "string" ? (LABELS[g.severity.toLowerCase()] ?? "unknown") : "unknown";
  const published_at = typeof g.published_at === "string" && TIMESTAMP.test(g.published_at) ? g.published_at : entry?.published;
  if (published_at === undefined) return fail("GHSA has no published_at");
  const modified_at = typeof g.updated_at === "string" && TIMESTAMP.test(g.updated_at) ? g.updated_at : published_at;
  const summary = (typeof g.summary === "string" ? oneLine(g.summary) : "") || (entry ? oneLine(entry.title) : pair.cve);
  const html = typeof g.html_url === "string" && /^https?:\/\//.test(g.html_url) ? [g.html_url] : [];
  const url = entry?.link ?? html[0];
  if (url === undefined) return fail("GHSA has no html_url and no php.net post links it");

  return {
    ok: true,
    doc: {
      cve_ids: [pair.cve],
      ghsa_id: pair.ghsa,
      ecosystem: "php",
      component: "php",
      affected: perLine.map((p, i) => ({ introduced: i === 0 && opensFromZero(rangeOf.get(p.fixed)) ? "0" : `${p.line}.0`, fixed: p.fixed })),
      fixed_versions: sorted,
      severity: score === undefined ? { label } : { score, label },
      exploited: false,
      published_at,
      modified_at,
      summary,
      action: actionFor(perLine, noFixLine),
      references: [...new Set([url, ...html])],
      sources: [{ source: SOURCE, source_id: pair.cve, url }],
    },
  };
}

// GHSA id -> the newest matching php.net post that links it.
function postFacts(html: string, match: string, maxPosts: number): Map<string, PostFacts> {
  const out = new Map<string, PostFacts>();
  const entries = parsePhpNews(html)
    .filter((e) => e.title.toLowerCase().includes(match))
    .sort((a, b) => (a.published > b.published ? -1 : a.published < b.published ? 1 : a.link < b.link ? -1 : a.link > b.link ? 1 : 0))
    .slice(0, maxPosts);
  for (const entry of entries) {
    const post = parsePhpPost(entry.content);
    const fixedVersions = parsePhpFixSentence(entry.content);
    for (const pair of post.pairs) {
      if (!out.has(pair.ghsa)) out.set(pair.ghsa, { entry, pair, noFixLine: post.noFixLine, fixedVersions });
    }
  }
  return out;
}

interface Listed {
  raw: unknown;
  ghsa: string;
  published: string;
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const cfg = readRuntimeConfig(SOURCE, ctx.source.config, PHP_DEFAULTS);
  const kv = ctx.env.CURSORS;
  const { stored, sinceMs } = await readSince(kv, PHP_CURSOR_KEY, ctx.now(), cfg.backfill_days);
  const result: RunResult = { fetched: 0, upserted: 0, unchanged: 0, errors: [] };

  // List newest first. Stop at the first advisory strictly older than the
  // cursor; one dated exactly at the cursor is read again (dedup makes it unchanged).
  const origin = new URL(cfg.ghsa_api_base).origin;
  const listed: Listed[] = [];
  let next: string | undefined = advisoriesPageUrl(cfg.ghsa_api_base, cfg.page_size);
  let older = false;
  while (next !== undefined && !older) {
    const page = await fetchGhsaListPage(ctx.fetch, next, ctx.env.GITHUB_TOKEN, origin);
    if (page.body.length === 0) break;
    for (const raw of page.body) {
      const g = (raw ?? {}) as { ghsa_id?: unknown; published_at?: unknown };
      const ghsa = typeof g.ghsa_id === "string" ? g.ghsa_id : "?";
      const published = typeof g.published_at === "string" && TIMESTAMP.test(g.published_at) ? g.published_at : undefined;
      if (published === undefined) {
        result.errors.push(`${ghsa}: no published_at in the advisories list`);
        continue;
      }
      if (new Date(published).getTime() < sinceMs) {
        older = true;
        break;
      }
      listed.push({ raw, ghsa, published });
      // Nothing is skipped silently: over the cap, the run stores nothing and the cursor holds.
      if (listed.length > cfg.max_advisories) {
        throw new Error(`php-runtime: more than ${cfg.max_advisories} advisories at or after the cursor (max_advisories); nothing stored, cursor not moved`);
      }
    }
    next = page.next;
  }

  // The second sources, read once per run and only when an advisory is new.
  let posts: Map<string, PostFacts> | undefined;
  let released: Set<string> | undefined;
  listed.sort((a, b) => (a.published < b.published ? -1 : a.published > b.published ? 1 : 0));
  for (const item of listed) {
    result.fetched += 1;
    const cve = (item.raw as { cve_id?: unknown }).cve_id;
    if (typeof cve !== "string" || !CVE.test(cve)) {
      result.errors.push(`${item.ghsa}: no CVE id yet`);
      continue;
    }
    const hit = await ctx.env.DB.prepare(PHP_DEDUP_SQL).bind(SOURCE, cve).first();
    if (hit !== null) {
      result.unchanged += 1;
      continue;
    }
    posts ??= postFacts(await fetchNews(ctx.fetch, cfg.news_url), cfg.title_match.toLowerCase(), cfg.max_posts);
    released ??= parsePhpReleases(await fetchReleases(ctx.fetch, cfg.releases_url));
    const post = posts.get(item.ghsa);
    const norm = normalizePhpAdvisory(post?.entry, post?.pair ?? { cve, ghsa: item.ghsa }, item.raw, post?.noFixLine, released, post?.fixedVersions);
    if (!norm.ok) {
      result.errors.push(norm.reason);
      continue;
    }
    try {
      const outcome = await upsertAdvisory(ctx.env.DB, norm.doc, { source: SOURCE, source_id: cve });
      if (outcome === "unchanged") result.unchanged += 1;
      else result.upserted += 1;
    } catch (err) {
      if (!(err instanceof InvalidAdvisoryError)) throw err;
      result.errors.push(`${cve}: ${err.message}`);
    }
  }

  // The cursor moves only after a run with no error, so an incomplete advisory is read again.
  if (result.errors.length > 0) return result;
  const newest = listed.reduce<string | null>((m, i) => (m === null || i.published > m ? i.published : m), null);
  const storedMs = stored === null ? NaN : new Date(stored).getTime();
  if (newest !== null && (Number.isNaN(storedMs) || new Date(newest).getTime() > storedMs)) await kv.put(PHP_CURSOR_KEY, newest);
  return result;
}

export const phpRuntime: Ingester = { id: SOURCE, run };
