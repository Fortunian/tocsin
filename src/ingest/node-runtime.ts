// The node-runtime ingester: reads the nodejs.org vulnerability feed, opens
// each "Security Release" post that the post ledger (node_runtime_posts,
// src/ingest/node-runtime-posts.ts) says is due, and emits one advisory per
// CVE heading. The post is the source of truth for fixed versions; the dist
// index confirms each fixed version exists.
import { markCoverage } from "./coverage";
import { fetchFeed, fetchPost, NodeHttpError, NodeLinkError } from "./node-runtime-client";
import { loadNodeDistIndex, type DistIndex } from "./node-runtime-dist";
import { readLedger, writePost, type Ledger, type PostRow, type PostWrite } from "./node-runtime-posts";
import { compareVersions } from "./osv";
import { htmlSections, htmlText, isoUtc, oneLine, readRuntimeConfig, RETRY_SCHEDULE, retryWaitMinutes, xmlBlocks, xmlText } from "./runtime-text";
import type { AdvisoryInput, IngestContext, Ingester, RunResult } from "./types";
import { InvalidAdvisoryError, upsertAdvisory } from "./upsert";
import type { SeverityLabel } from "../schema/advisory";

// The parser revision a ledger row was read with (node_runtime_posts.parser_rev).
// A row with another value is read again once, so posts the old parser could
// not read are picked up (TCS-30: the July 2026 wording; TCS-32: the whole feed
// history once). Parser identity, not a limit.
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
  // A post older than this with no CVE heading is a terminal "empty" post.
  // Seeded in the node-runtime row by migrations/0015_node_history.sql.
  retry_incomplete_days: 365,
  // Minutes until a pending post (a pre-announcement) younger than
  // retry_incomplete_days, or a recent post with no CVE heading, is read again.
  // Seeded in the node-runtime row by migrations/0020_node_runtime_posts.sql.
  pending_recheck_minutes: 60,
  // Minutes until a pending post older than retry_incomplete_days is read again.
  // Seeded in the node-runtime row by migrations/0020_node_runtime_posts.sql.
  pending_old_recheck_minutes: 10080,
  // Reads of a post before it is terminal "empty": a recent post that is
  // incomplete or has no CVE heading, and a pending post (a pre-announcement).
  // Seeded in the node-runtime row by migrations/0020_node_runtime_posts.sql.
  max_attempts: 10,
  // Wait after failed read 1, 2, 3, ... of a recent post; the last value
  // repeats (1 hour, 6 hours, 24 hours, then weekly).
  // Seeded in the node-runtime row by migrations/0020_node_runtime_posts.sql.
  retry_schedule_minutes: "60,360,1440,10080",
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
  // the post emits nothing (run: a failed row with the retry schedule).
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

function isNodePreAnnouncementParsed(parsed: ParsedPost, html: string): boolean {
  return parsed.cves.length === 0 && parsed.unparsed.length === 0 && PRE_ANNOUNCE.test(htmlText(html));
}

// A post with no CVE heading (rated or not) whose text announces a coming release.
export function isNodePreAnnouncement(html: string): boolean {
  return isNodePreAnnouncementParsed(parseNodeSecurityPost(html), html);
}

export function normalizeNodePost(post: { link: string; published: string }, html: string, dist: Set<string>): NormalizedPost {
  const parsed = parseNodeSecurityPost(html);
  if (isNodePreAnnouncementParsed(parsed, html)) return { docs: [], errors: [], incomplete: false, preAnnouncement: true, needsDist: false, notEmitted: 0 };
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

function byPublished(a: FeedItem, b: FeedItem): number {
  return a.published < b.published ? -1 : a.published > b.published ? 1 : a.link < b.link ? -1 : a.link > b.link ? 1 : 0;
}


type NodeConfig = typeof NODE_DEFAULTS;

// One run's state. `errors` is only for a failure of the run itself (the feed,
// the dist index or D1 thrown out of the run): every outcome of one post is a
// ledger row plus a summary line, and a note an operator must see is a warning.
interface Walk {
  ctx: IngestContext;
  cfg: NodeConfig;
  now: Date;
  result: RunResult;
  summary: string[];
  warnings: string[];
  written: Set<string>;
  allowedOrigin: string;
  dist?: DistIndex;
  forced: boolean;
}

interface DuePost {
  post: FeedItem;
  prev?: PostRow;
}

function readNodeConfig(raw: Record<string, unknown>): NodeConfig {
  const cfg = readRuntimeConfig(SOURCE, raw, NODE_DEFAULTS);
  if (!RETRY_SCHEDULE.test(cfg.retry_schedule_minutes)) throw new Error(`${SOURCE} config: retry_schedule_minutes must be a comma list of positive integers`);
  return cfg;
}

const isOld = (w: Walk, post: FeedItem) => w.now.getTime() - new Date(post.published).getTime() > w.cfg.retry_incomplete_days * 86_400_000;
const after = (w: Walk, minutes: number) => new Date(w.now.getTime() + minutes * 60_000).toISOString();

// The row is written after the post's advisories are stored, in the same step as its note.
async function write(w: Walk, post: FeedItem, row: Omit<PostWrite, "url" | "published" | "parser_rev" | "title">): Promise<void> {
  await writePost(w.ctx.env.DB, { url: post.link, published: post.published, title: post.title, parser_rev: NODE_PARSER_REV, ...row }, w.now);
  w.written.add(post.link);
}

// The posts this run reads: a feed post with no row, a re-published post or
// one read by another parser revision; a pending or failed row whose
// next_check_at has come (by its stored URL, date and title, even if the post
// left the feed); and the newest feed post when its row is ok or empty,
// because Node edits a post in place (a pre-announcement becomes the release).
function selectDue(feed: FeedItem[], ledger: Ledger, inWindow: (published: string) => boolean): DuePost[] {
  const due = new Map<string, DuePost>();
  for (const p of feed) {
    const row = ledger.known.get(p.link);
    if (!row || row.published !== p.published || row.parser_rev !== NODE_PARSER_REV) due.set(p.link, { post: p, prev: row });
  }
  for (const row of ledger.due) {
    if (due.has(row.url) || !inWindow(row.published)) continue;
    const post = feed.find((p) => p.link === row.url) ?? { title: row.title ?? postLabel(row.url), link: row.url, published: row.published };
    due.set(row.url, { post, prev: row });
  }
  const newest = [...feed].sort(byPublished).pop()!;
  const newestRow = ledger.known.get(newest.link);
  if ((newestRow?.state === "ok" || newestRow?.state === "empty") && !due.has(newest.link)) due.set(newest.link, { post: newest, prev: newestRow });
  return [...due.values()].sort((a, b) => byPublished(a.post, b.post));
}

// A read that can still clear (a recent post that is incomplete or has no CVE
// heading): failed with the retry schedule, then terminal empty at max_attempts.
// One warning per read; none when the row was already terminal (the newest post).
async function retryLater(w: Walk, d: DuePost, why: string): Promise<void> {
  const label = postLabel(d.post.link);
  const n = (d.prev?.state === "failed" ? d.prev.attempts : 0) + 1;
  const lastError = `${d.post.link}: ${why}`;
  if (d.prev?.state === "empty" || n >= w.cfg.max_attempts) {
    if (d.prev?.state !== "empty") w.warnings.push(`${label}: ${why}, after ${n} reads, not read again`);
    w.summary.push(`${label}: ${why}, not read again`);
    return write(w, d.post, { state: "empty", attempts: n, last_error: lastError });
  }
  const next = after(w, retryWaitMinutes(w.cfg.retry_schedule_minutes, n));
  w.warnings.push(`${label}: ${why}, read ${n} of ${w.cfg.max_attempts}, read again after ${next}`);
  w.summary.push(`${label}: ${why}, read again after ${next}`);
  await write(w, d.post, { state: "failed", attempts: n, last_error: lastError, next_check_at: next });
}

// A pre-announcement waits for its CVE headings: pending, read again after
// pending_recheck_minutes (old posts: pending_old_recheck_minutes), terminal
// empty with one warning after max_attempts reads.
async function waitPending(w: Walk, d: DuePost): Promise<void> {
  const label = postLabel(d.post.link);
  const n = (d.prev?.state === "pending" ? d.prev.attempts : 0) + 1;
  if (d.prev?.state === "empty" || n >= w.cfg.max_attempts) {
    if (d.prev?.state !== "empty") w.warnings.push(`${label}: pre-announcement with no release after ${n} reads, not read again`);
    w.summary.push(`${label}: pre-announcement, not read again`);
    return write(w, d.post, { state: "empty", attempts: n, last_error: `${d.post.link}: pre-announcement with no release after ${n} reads` });
  }
  const next = after(w, isOld(w, d.post) ? w.cfg.pending_old_recheck_minutes : w.cfg.pending_recheck_minutes);
  w.summary.push(`${label}: pre-announcement, read again after ${next}`);
  await write(w, d.post, { state: "pending", attempts: n, next_check_at: next });
}

// A permanent data problem of one post (an old post that is gone or that the
// parser cannot complete): one warning, a terminal failed row.
async function failTerminal(w: Walk, d: DuePost, note: string, line: string): Promise<void> {
  w.warnings.push(note);
  w.summary.push(`${postLabel(d.post.link)}: ${line}`);
  await write(w, d.post, { state: "failed", attempts: (d.prev?.attempts ?? 0) + 1, last_error: note });
}

// The post page, or undefined when the read failed for a reason of this post
// (its row is then written). Other HTTP and D1 errors throw out of the run.
async function fetchHtml(w: Walk, d: DuePost): Promise<string | undefined> {
  try {
    return await fetchPost(w.ctx.fetch, d.post.link, w.allowedOrigin);
  } catch (err) {
    const gone = err instanceof NodeHttpError && (err.status === 404 || err.status === 410) && isOld(w, d.post);
    if (!(err instanceof NodeLinkError) && !gone) throw err;
    await failTerminal(w, d, err.message, "not read");
    return undefined;
  }
}

// Normalizes against the dist index, read on the first post that needs it
// (KV cache when fresh; origin once per run when the cache is older than the post).
async function normalize(w: Walk, post: FeedItem, html: string): Promise<NormalizedPost> {
  const load = (force: boolean) => loadNodeDistIndex(w.ctx.fetch, w.ctx.env.CURSORS, w.cfg.dist_index_url, w.cfg.dist_cache_seconds, w.now, force);
  w.dist ??= await load(false);
  let norm = normalizeNodePost(post, html, w.dist.versions);
  if (norm.needsDist && w.dist.fromCache && !w.forced) {
    w.forced = true;
    w.dist = await load(true);
    norm = normalizeNodePost(post, html, w.dist.versions);
  }
  return norm;
}

// Stores the post's advisories; an advisory that fails validation is a warning.
async function storeDocs(w: Walk, d: DuePost, norm: NormalizedPost): Promise<void> {
  const { result } = w;
  let ok = 0;
  let notEmitted = norm.notEmitted;
  w.warnings.push(...norm.errors);
  for (const doc of norm.docs) {
    result.fetched += 1;
    try {
      const outcome = await upsertAdvisory(w.ctx.env.DB, doc, { source: SOURCE, source_id: doc.sources[0].source_id });
      if (outcome === "unchanged") result.unchanged += 1;
      else result.upserted += 1;
      ok += 1;
    } catch (err) {
      if (!(err instanceof InvalidAdvisoryError)) throw err;
      w.warnings.push(`${doc.sources[0].source_id}: ${err.message}`);
      notEmitted += 1;
    }
  }
  const label = postLabel(d.post.link);
  w.summary.push(notEmitted > 0 ? `${label}: ${ok} ok, ${notEmitted} not emitted` : `${label}: ${ok} ok`);
  await write(w, d.post, { state: "ok", attempts: 0 });
}

// One post: always records an outcome, never stops the walk.
async function readOne(w: Walk, d: DuePost): Promise<void> {
  const html = await fetchHtml(w, d);
  if (html === undefined) return;
  const parsed = parseNodeSecurityPost(html);
  if (parsed.cves.length === 0 && parsed.unparsed.length === 0) {
    if (isNodePreAnnouncementParsed(parsed, html)) return waitPending(w, d);
    if (!isOld(w, d.post)) return retryLater(w, d, "no CVE headings");
    // A historical post with nothing to emit (the 2019 "no updates" post): one warning.
    if (d.prev?.state !== "empty") w.warnings.push(`${postLabel(d.post.link)}: no CVE headings, older than ${w.cfg.retry_incomplete_days} days, not read again`);
    w.summary.push(`${postLabel(d.post.link)}: no CVE headings, not read again`);
    return write(w, d.post, { state: "empty", attempts: d.prev?.attempts ?? 0 });
  }
  const norm = await normalize(w, d.post, html);
  if (!norm.incomplete) return storeDocs(w, d, norm);
  const detail = norm.errors.map((e) => e.replace(`${d.post.link}: `, "")).join("; ");
  if (!isOld(w, d.post)) return retryLater(w, d, detail.replace("post incomplete, read again next run", "post incomplete"));
  const note = `post incomplete, older than ${w.cfg.retry_incomplete_days} days, not read again`;
  await failTerminal(w, d, norm.errors.map((e) => e.replace("post incomplete, read again next run", note)).join("; "), "incomplete, not read again");
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const cfg = readNodeConfig(ctx.source.config);
  const now = ctx.now();
  const match = cfg.title_match.toLowerCase();
  const result: RunResult = { fetched: 0, upserted: 0, unchanged: 0, errors: [] };
  const windowStart = now.getTime() - cfg.backfill_days * 86_400_000;
  const inWindow = (published: string) => new Date(published).getTime() >= windowStart;

  const releases = parseNodeFeed(await fetchFeed(ctx.fetch, cfg.feed_url)).filter((p) => p.title.toLowerCase().includes(match));
  const feed = releases.filter((p) => inWindow(p.published));
  if (feed.length === 0) return result;
  const ledger = await readLedger(ctx.env.DB, feed.map((p) => p.link), now, cfg.max_posts);
  const ordered = selectDue(feed, ledger, inWindow);
  const posts = ordered.slice(0, cfg.max_posts);
  if (ordered.length > posts.length) {
    // The rest stay due in the ledger: the next run reads them.
    result.deferred = ordered.length - posts.length;
    result.incomplete = true;
  }

  // Post links are read only on the origin of the configured feed.
  const w: Walk = { ctx, cfg, now, result, summary: [], warnings: [], written: new Set(), allowedOrigin: new URL(cfg.feed_url).origin, forced: false };
  for (const d of posts) await readOne(w, d);
  if (w.summary.length > 0) result.summary = w.summary.join("; ");
  if (w.warnings.length > 0) result.warnings = w.warnings;
  // The history is read in full when every feed post of the window has a row
  // (any outcome, a failed post with its backoff included) and the window
  // reaches the oldest release post of the feed.
  const oldest = releases.reduce<string | null>((m, p) => (m === null || p.published < m ? p.published : m), null);
  const allRead = feed.every((p) => ledger.known.has(p.link) || w.written.has(p.link));
  if (!ctx.source.coverage_since && allRead && oldest !== null && inWindow(oldest)) await markCoverage(ctx.env.DB, SOURCE, oldest);
  return result;
}

export const nodeRuntime: Ingester = { id: SOURCE, run };
