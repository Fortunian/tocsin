// The node-runtime ingester: reads the nodejs.org vulnerability feed, opens
// each "Security Release" post newer than the KV cursor, and emits one
// advisory per CVE heading. The post is the source of truth for fixed
// versions; the dist index confirms each fixed version exists.
import { markCoverage } from "./coverage";
import { fetchFeed, fetchPost, NodeHttpError, NodeLinkError } from "./node-runtime-client";
import { loadNodeDistIndex, type DistIndex } from "./node-runtime-dist";
import { compareVersions } from "./osv";
import { htmlSections, htmlText, isoUtc, oneLine, readRuntimeConfig, readSince, xmlBlocks, xmlText } from "./runtime-text";
import type { AdvisoryInput, IngestContext, Ingester, RunResult } from "./types";
import { InvalidAdvisoryError, upsertAdvisory } from "./upsert";
import type { SeverityLabel } from "../schema/advisory";

export const NODE_CURSOR_KEY = "cursor:node-runtime";
// The parser revision the stored cursor was read with. A run that finds another
// value reads the backfill window again once, so posts the old parser could not
// read are picked up (TCS-30: the July 2026 wording; TCS-32: the whole feed
// history once, with backfill_days 4000). Parser identity, not a limit.
export const NODE_PARSER_KEY = "cursor:node-runtime:parser";
export const NODE_PARSER_REV = "3";
const SOURCE = "node-runtime";

// Code fallbacks for sources.config_json of row "node-runtime" (repo iron rule 5).
export const NODE_DEFAULTS = {
  feed_url: "https://nodejs.org/en/feed/vulnerability.xml",
  dist_index_url: "https://nodejs.org/dist/index.json",
  title_match: "Security Release",
  backfill_days: 120,
  max_posts: 5,
  // Freshness window of the KV dist index cache, in seconds.
  dist_cache_seconds: 3600,
  // An incomplete post older than this is reported and passed, not read
  // again: an old post the parser cannot complete must not stop the history read.
  // Seeded in the node-runtime row by migrations/0015_node_history.sql.
  retry_incomplete_days: 365,
};

export interface FeedItem {
  title: string;
  link: string;
  published: string;
}

export interface PostCve {
  cve: string;
  title: string;
  rating: SeverityLabel;
  lines: number[];
}

export interface ParsedPost {
  cves: PostCve[];
  // Headings that name a CVE but do not have the "(CVE-…) - (<rating>)" shape.
  unparsed: string[];
  // Release line (major) -> fixed version, from "Downloads and release details".
  fixed: Map<number, string>;
}

export interface NormalizedPost {
  docs: AdvisoryInput[];
  errors: string[];
  // True when a fixed version is missing from the post or the dist index:
  // the post emits nothing and is read again on the next run.
  incomplete: boolean;
  // True for a pre-announcement: no CVE headings yet, so nothing to emit and no error.
  preAnnouncement: boolean;
  // True when a fixed version the post names is not in the given dist set.
  needsDist: boolean;
  // CVE headings of the post that gave no advisory (no rating, no release lines).
  notEmitted: number;
}

const CVE_HEADING = /^(.+?) \((CVE-\d{4}-\d{4,})\) - \((critical|high|medium|low)\)$/i;
const HAS_CVE = /CVE-\d{4}-\d{4,}/;
// "affects Node.js 24.x, 22.x", "affects all users [of <feature>] in active
// release lines: 24.x, 22.x" (July 2026) and "affects all active release lines: 24.x".
const AFFECTS =
  /affects\s+(?:Node\.js|(?:all\s+users(?:\s+of\s+[^:.]{1,80}?)?\s+in\s+)?(?:all\s+)?active\s+release\s+lines:)\s+((?:\d+\.x(?:\s*,\s*and\s+|\s*,\s*|\s+and\s+)?)+)/i;
// Wording of the pre-announcement Node posts about a week before release day.
// It counts only for a post with no CVE heading: the final post keeps this text.
const PRE_ANNOUNCE = /pre-announcement|will be released|will release new versions|releases will be available/i;
const DOWNLOADS = /^Downloads and release details$/i;

export function parseNodeFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const block of xmlBlocks(xml, "item")) {
    const title = xmlText(block, "title");
    const link = xmlText(block, "link");
    const pub = xmlText(block, "pubDate");
    const published = pub === undefined ? undefined : isoUtc(pub);
    if (title && link && /^https?:\/\//.test(link) && published) items.push({ title, link, published });
  }
  return items;
}

export function parseNodeSecurityPost(html: string): ParsedPost {
  const cves: PostCve[] = [];
  const unparsed: string[] = [];
  const fixed = new Map<number, string>();
  for (const s of htmlSections(html)) {
    const m = CVE_HEADING.exec(s.heading);
    if (m) {
      const affects = AFFECTS.exec(htmlText(s.body));
      const lines = affects ? [...new Set([...affects[1].matchAll(/(\d+)\.x/g)].map((x) => Number(x[1])))].sort((a, b) => a - b) : [];
      cves.push({ cve: m[2].toUpperCase(), title: m[1], rating: m[3].toLowerCase() as SeverityLabel, lines });
    } else if (HAS_CVE.test(s.heading)) {
      unparsed.push(s.heading);
    } else if (DOWNLOADS.test(s.heading)) {
      for (const v of htmlText(s.body).matchAll(/Node\.js v(\d+)\.(\d+)\.(\d+)\b/g)) {
        const major = Number(v[1]);
        const version = `${v[1]}.${v[2]}.${v[3]}`;
        const prev = fixed.get(major);
        if (prev === undefined || compareVersions(version, prev) > 0) fixed.set(major, version);
      }
    }
  }
  return { cves, unparsed, fixed };
}

// "Upgrade node to 24.22.1 or later." for one line; each line's version for several.
function actionFor(perLine: { line: number; fixed: string }[]): string {
  if (perLine.length === 1) return `Upgrade node to ${perLine[0].fixed} or later.`;
  const parts = perLine.map((p) => `${p.fixed} (${p.line}.x)`);
  const text = `Upgrade node to ${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]} or later.`;
  return text.length <= 200 ? text : `Upgrade node to ${perLine[0].fixed} or later.`;
}

function isPreAnnouncement(parsed: ParsedPost, html: string): boolean {
  return parsed.cves.length === 0 && parsed.unparsed.length === 0 && PRE_ANNOUNCE.test(htmlText(html));
}

// A post with no CVE heading (rated or not) whose text announces a coming release.
export function isNodePreAnnouncement(html: string): boolean {
  return isPreAnnouncement(parseNodeSecurityPost(html), html);
}

export function normalizeNodePost(post: { link: string; published: string }, html: string, dist: Set<string>): NormalizedPost {
  const parsed = parseNodeSecurityPost(html);
  if (isPreAnnouncement(parsed, html)) return { docs: [], errors: [], incomplete: false, preAnnouncement: true, needsDist: false, notEmitted: 0 };
  const errors: string[] = parsed.unparsed.map((h) => `${post.link}: CVE heading without a rating, not emitted: ${oneLine(h)}`);
  if (parsed.cves.length === 0 && parsed.unparsed.length === 0) errors.push(`${post.link}: no CVE headings`);
  let notEmitted = parsed.unparsed.length;
  let needsDist = false;

  const missing = new Set<string>();
  const docs: AdvisoryInput[] = [];
  for (const c of parsed.cves) {
    if (c.lines.length === 0) {
      errors.push(`${post.link}: ${c.cve}: no affected release lines, not emitted`);
      notEmitted += 1;
      continue;
    }
    const perLine: { line: number; fixed: string }[] = [];
    for (const line of c.lines) {
      const fixed = parsed.fixed.get(line);
      if (fixed === undefined) missing.add(`no fixed version for ${line}.x`);
      else if (!dist.has(`v${fixed}`)) {
        missing.add(`${fixed} is not in the dist index`);
        needsDist = true;
      }
      else perLine.push({ line, fixed });
    }
    if (perLine.length !== c.lines.length) continue;
    docs.push({
      cve_ids: [c.cve],
      ecosystem: "node",
      component: "node",
      affected: perLine.map((p) => ({ introduced: `${p.line}.0.0`, fixed: p.fixed })),
      fixed_versions: perLine.map((p) => p.fixed),
      severity: { label: c.rating },
      exploited: false,
      published_at: post.published,
      modified_at: post.published,
      summary: oneLine(c.title),
      action: actionFor(perLine),
      references: [post.link],
      sources: [{ source: SOURCE, source_id: c.cve, url: post.link }],
    });
  }
  if (missing.size > 0) {
    errors.push(`${post.link}: post incomplete, read again next run: ${[...missing].sort().join("; ")}`);
    return { docs: [], errors, incomplete: true, preAnnouncement: false, needsDist, notEmitted };
  }
  return { docs, errors, incomplete: false, preAnnouncement: false, needsDist, notEmitted };
}

// The last non-empty path segment of a post link, for the per-post summary.
function postLabel(link: string): string {
  try {
    return new URL(link).pathname.split("/").filter((x) => x !== "").pop() ?? link;
  } catch {
    return link;
  }
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const cfg = readRuntimeConfig(SOURCE, ctx.source.config, NODE_DEFAULTS);
  const kv = ctx.env.CURSORS;
  const now = ctx.now();
  let { sinceMs } = await readSince(kv, NODE_CURSOR_KEY, now, cfg.backfill_days);
  if ((await kv.get(NODE_PARSER_KEY)) !== NODE_PARSER_REV) {
    // A new parser revision: move the cursor back to the backfill window once.
    // The cursor then advances post by post as usual, so an incomplete or
    // failed post in the window is read again on the next run.
    sinceMs = Math.min(sinceMs, now.getTime() - cfg.backfill_days * 86_400_000);
    await kv.put(NODE_CURSOR_KEY, new Date(sinceMs).toISOString());
    await kv.put(NODE_PARSER_KEY, NODE_PARSER_REV);
  }
  const match = cfg.title_match.toLowerCase();
  const result: RunResult = { fetched: 0, upserted: 0, unchanged: 0, errors: [] };
  const summary: string[] = [];

  // A post dated exactly at the cursor is read again: Node edits a release post in place.
  const releases = parseNodeFeed(await fetchFeed(ctx.fetch, cfg.feed_url)).filter((p) => p.title.toLowerCase().includes(match));
  const due = releases
    .filter((p) => new Date(p.published).getTime() >= sinceMs)
    .sort((a, b) => (a.published < b.published ? -1 : a.published > b.published ? 1 : a.link < b.link ? -1 : a.link > b.link ? 1 : 0));
  const posts = due.slice(0, cfg.max_posts);
  if (posts.length === 0) return result;
  // The history is read in full when this run reads every due post to the
  // newest one, and the backfill window reaches the oldest release post of
  // the feed (the parser revision moved the cursor to the window start once).
  const oldest = releases.reduce<string | null>((m, p) => (m === null || p.published < m ? p.published : m), null);
  const windowStart = now.getTime() - cfg.backfill_days * 86_400_000;
  let reachedNewest = due.length <= cfg.max_posts;

  // The dist index is read on the first post that needs it, from the KV cache when fresh.
  let dist: DistIndex | undefined;
  let forced = false;
  const loadDist = (force: boolean) => loadNodeDistIndex(ctx.fetch, kv, cfg.dist_index_url, cfg.dist_cache_seconds, now, force);
  // Post links are read only on the origin of the configured feed.
  const allowedOrigin = new URL(cfg.feed_url).origin;
  const isOld = (post: FeedItem) => now.getTime() - new Date(post.published).getTime() > cfg.retry_incomplete_days * 86_400_000;
  for (const post of posts) {
    const label = postLabel(post.link);
    // HTTP and D1 errors throw out of the run: this post's cursor is not written.
    let html: string;
    try {
      html = await fetchPost(ctx.fetch, post.link, allowedOrigin);
    } catch (err) {
      // A post older than retry_incomplete_days that is gone (404, 410) is a
      // permanent data problem too: it must not stop the history read.
      const gone = err instanceof NodeHttpError && (err.status === 404 || err.status === 410) && isOld(post);
      if (!(err instanceof NodeLinkError) && !gone) throw err;
      // A permanent data problem in the feed: report it and move the cursor past the post.
      result.errors.push(err.message);
      summary.push(`${label}: not read`);
      await kv.put(NODE_CURSOR_KEY, post.published);
      continue;
    }
    // A pre-announcement is not a failure. It writes no cursor and stops the
    // run, so the post is read again until it carries its CVE headings.
    if (isNodePreAnnouncement(html)) {
      summary.push(`${label}: pre-announcement, read again next run`);
      reachedNewest = false;
      break;
    }
    dist ??= await loadDist(false);
    let norm = normalizeNodePost(post, html, dist.versions);
    if (norm.needsDist && dist.fromCache && !forced) {
      // The cached set is older than this post: read origin once in this run.
      forced = true;
      dist = await loadDist(true);
      norm = normalizeNodePost(post, html, dist.versions);
    }
    // An incomplete post stops the run; the cursor stays at the last complete
    // post. One older than retry_incomplete_days is reported and passed.
    if (norm.incomplete && isOld(post)) {
      const note = `post incomplete, older than ${cfg.retry_incomplete_days} days, not read again`;
      result.errors.push(...norm.errors.map((e) => e.replace("post incomplete, read again next run", note)));
      summary.push(`${label}: incomplete, not read again`);
      await kv.put(NODE_CURSOR_KEY, post.published);
      continue;
    }
    result.errors.push(...norm.errors);
    if (norm.incomplete) {
      summary.push(`${label}: incomplete, read again next run`);
      reachedNewest = false;
      break;
    }
    let ok = 0;
    let notEmitted = norm.notEmitted;
    for (const doc of norm.docs) {
      result.fetched += 1;
      try {
        const outcome = await upsertAdvisory(ctx.env.DB, doc, { source: SOURCE, source_id: doc.sources[0].source_id });
        if (outcome === "unchanged") result.unchanged += 1;
        else result.upserted += 1;
        ok += 1;
      } catch (err) {
        if (!(err instanceof InvalidAdvisoryError)) throw err;
        result.errors.push(`${doc.sources[0].source_id}: ${err.message}`);
        notEmitted += 1;
      }
    }
    summary.push(notEmitted > 0 ? `${label}: ${ok} ok, ${notEmitted} not emitted` : `${label}: ${ok} ok`);
    await kv.put(NODE_CURSOR_KEY, post.published);
  }
  if (summary.length > 0) result.summary = summary.join("; ");
  if (!ctx.source.coverage_since && reachedNewest && oldest !== null && new Date(oldest).getTime() >= windowStart) {
    await markCoverage(ctx.env.DB, SOURCE, oldest);
  }
  return result;
}

export const nodeRuntime: Ingester = { id: SOURCE, run };
