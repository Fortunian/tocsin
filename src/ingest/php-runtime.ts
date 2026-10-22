// The php-runtime ingester: reads the php.net news page, opens each
// "Security advisory" post newer than the KV cursor, and emits one advisory
// per CVE the post pairs with a php-src GitHub advisory (GHSA). The GHSA
// gives the patched versions and the CVSS score; the php.net releases feed
// confirms each patched version is released.
import { compareVersions } from "./osv";
import { fetchGhsa, fetchNews, fetchReleases } from "./php-runtime-client";
import { decodeEntities, htmlText, isoUtc, oneLine, readRuntimeConfig, readSince, xmlBlocks } from "./runtime-text";
import type { AdvisoryInput, IngestContext, Ingester, RunResult } from "./types";
import { InvalidAdvisoryError, upsertAdvisory } from "./upsert";
import type { SeverityLabel } from "../schema/advisory";

export const PHP_CURSOR_KEY = "cursor:php-runtime";
const SOURCE = "php-runtime";

// Dedup before the GitHub call: one seek on the advisory_sources primary key.
export const PHP_DEDUP_SQL = "SELECT 1 AS hit FROM advisory_sources WHERE source = ? AND source_id = ?";

// Code fallbacks for sources.config_json of row "php-runtime" (repo iron rule 5).
export const PHP_DEFAULTS = {
  news_url: "https://www.php.net/index.php",
  releases_url: "https://www.php.net/releases/feed.php",
  ghsa_api_base: "https://api.github.com/repos/php/php-src/security-advisories",
  title_match: "Security advisory",
  backfill_days: 120,
  max_posts: 5,
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

export function normalizePhpAdvisory(
  entry: Pick<NewsEntry, "title" | "link" | "published">,
  pair: CvePair,
  raw: unknown,
  noFixLine: string | undefined,
  released: Set<string>,
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
  if (fixed.size === 0) return fail("GHSA has no patched version");
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
  const published_at = typeof g.published_at === "string" && TIMESTAMP.test(g.published_at) ? g.published_at : entry.published;
  const modified_at = typeof g.updated_at === "string" && TIMESTAMP.test(g.updated_at) ? g.updated_at : published_at;
  const summary = (typeof g.summary === "string" ? oneLine(g.summary) : "") || oneLine(entry.title);
  const html = typeof g.html_url === "string" && /^https?:\/\//.test(g.html_url) ? [g.html_url] : [];

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
      references: [...new Set([entry.link, ...html])],
      sources: [{ source: SOURCE, source_id: pair.cve, url: entry.link }],
    },
  };
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const cfg = readRuntimeConfig(SOURCE, ctx.source.config, PHP_DEFAULTS);
  const kv = ctx.env.CURSORS;
  const { sinceMs } = await readSince(kv, PHP_CURSOR_KEY, ctx.now(), cfg.backfill_days);
  const match = cfg.title_match.toLowerCase();
  const result: RunResult = { fetched: 0, upserted: 0, unchanged: 0, errors: [] };

  // A post dated exactly at the cursor is read again, as in node-runtime.
  const entries = parsePhpNews(await fetchNews(ctx.fetch, cfg.news_url))
    .filter((e) => e.title.toLowerCase().includes(match) && new Date(e.published).getTime() >= sinceMs)
    .sort((a, b) => (a.published < b.published ? -1 : a.published > b.published ? 1 : a.link < b.link ? -1 : a.link > b.link ? 1 : 0))
    .slice(0, cfg.max_posts);

  let released: Set<string> | undefined;
  for (const entry of entries) {
    const post = parsePhpPost(entry.content);
    if (post.pairs.length === 0) result.errors.push(`${entry.link}: no CVE/GHSA pairs in the post`);

    const docs: AdvisoryInput[] = [];
    let incomplete = false;
    for (const pair of post.pairs) {
      // HTTP and D1 errors throw out of the run: this post's cursor is not written.
      const hit = await ctx.env.DB.prepare(PHP_DEDUP_SQL).bind(SOURCE, pair.cve).first();
      if (hit !== null) {
        result.unchanged += 1;
        continue;
      }
      const ghsa = await fetchGhsa(ctx.fetch, cfg.ghsa_api_base, pair.ghsa, ctx.env.GITHUB_TOKEN);
      result.fetched += 1;
      released ??= parsePhpReleases(await fetchReleases(ctx.fetch, cfg.releases_url));
      const norm = normalizePhpAdvisory(entry, pair, ghsa, post.noFixLine, released);
      if (norm.ok) docs.push(norm.doc);
      else {
        result.errors.push(`${entry.link}: ${norm.reason}`);
        if (norm.incomplete) incomplete = true;
      }
    }
    // An incomplete post emits nothing and stops the run; it is read again next run.
    if (incomplete) break;

    for (const doc of docs) {
      try {
        const outcome = await upsertAdvisory(ctx.env.DB, doc, { source: SOURCE, source_id: doc.sources[0].source_id });
        if (outcome === "unchanged") result.unchanged += 1;
        else result.upserted += 1;
      } catch (err) {
        if (!(err instanceof InvalidAdvisoryError)) throw err;
        result.errors.push(`${doc.sources[0].source_id}: ${err.message}`);
      }
    }
    await kv.put(PHP_CURSOR_KEY, entry.published);
  }
  return result;
}

export const phpRuntime: Ingester = { id: SOURCE, run };
