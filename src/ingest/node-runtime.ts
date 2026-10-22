// The node-runtime ingester: reads the nodejs.org vulnerability feed, opens
// each "Security Release" post newer than the KV cursor, and emits one
// advisory per CVE heading. The post is the source of truth for fixed
// versions; the dist index confirms each fixed version exists.
import { fetchDistIndex, fetchFeed, fetchPost } from "./node-runtime-client";
import { compareVersions } from "./osv";
import { htmlSections, htmlText, isoUtc, oneLine, readRuntimeConfig, readSince, xmlBlocks, xmlText } from "./runtime-text";
import type { AdvisoryInput, IngestContext, Ingester, RunResult } from "./types";
import { InvalidAdvisoryError, upsertAdvisory } from "./upsert";
import type { SeverityLabel } from "../schema/advisory";

export const NODE_CURSOR_KEY = "cursor:node-runtime";
const SOURCE = "node-runtime";

// Code fallbacks for sources.config_json of row "node-runtime" (repo iron rule 5).
export const NODE_DEFAULTS = {
  feed_url: "https://nodejs.org/en/feed/vulnerability.xml",
  dist_index_url: "https://nodejs.org/dist/index.json",
  title_match: "Security Release",
  backfill_days: 120,
  max_posts: 5,
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
}

const CVE_HEADING = /^(.+?) \((CVE-\d{4}-\d{4,})\) - \((critical|high|medium|low)\)$/i;
const HAS_CVE = /CVE-\d{4}-\d{4,}/;
const AFFECTS = /affects Node\.js\s+((?:\d+\.x(?:\s*,\s*and\s+|\s*,\s*|\s+and\s+)?)+)/i;
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

export function normalizeNodePost(post: { link: string; published: string }, html: string, dist: Set<string>): NormalizedPost {
  const parsed = parseNodeSecurityPost(html);
  const errors: string[] = parsed.unparsed.map((h) => `${post.link}: CVE heading without a rating, not emitted: ${oneLine(h)}`);
  if (parsed.cves.length === 0 && parsed.unparsed.length === 0) errors.push(`${post.link}: no CVE headings`);

  const missing = new Set<string>();
  const docs: AdvisoryInput[] = [];
  for (const c of parsed.cves) {
    if (c.lines.length === 0) {
      errors.push(`${post.link}: ${c.cve}: no affected release lines, not emitted`);
      continue;
    }
    const perLine: { line: number; fixed: string }[] = [];
    for (const line of c.lines) {
      const fixed = parsed.fixed.get(line);
      if (fixed === undefined) missing.add(`no fixed version for ${line}.x`);
      else if (!dist.has(`v${fixed}`)) missing.add(`${fixed} is not in the dist index`);
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
    return { docs: [], errors, incomplete: true };
  }
  return { docs, errors, incomplete: false };
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const cfg = readRuntimeConfig(SOURCE, ctx.source.config, NODE_DEFAULTS);
  const kv = ctx.env.CURSORS;
  const { sinceMs } = await readSince(kv, NODE_CURSOR_KEY, ctx.now(), cfg.backfill_days);
  const match = cfg.title_match.toLowerCase();
  const result: RunResult = { fetched: 0, upserted: 0, unchanged: 0, errors: [] };

  // A post dated exactly at the cursor is read again: Node edits a release post in place.
  const posts = parseNodeFeed(await fetchFeed(ctx.fetch, cfg.feed_url))
    .filter((p) => p.title.toLowerCase().includes(match) && new Date(p.published).getTime() >= sinceMs)
    .sort((a, b) => (a.published < b.published ? -1 : a.published > b.published ? 1 : a.link < b.link ? -1 : a.link > b.link ? 1 : 0))
    .slice(0, cfg.max_posts);
  if (posts.length === 0) return result;

  const dist = await fetchDistIndex(ctx.fetch, cfg.dist_index_url);
  for (const post of posts) {
    // HTTP and D1 errors throw out of the run: this post's cursor is not written.
    const norm = normalizeNodePost(post, await fetchPost(ctx.fetch, post.link), dist);
    result.errors.push(...norm.errors);
    // An incomplete post stops the run; the cursor stays at the last complete post.
    if (norm.incomplete) break;
    for (const doc of norm.docs) {
      result.fetched += 1;
      try {
        const outcome = await upsertAdvisory(ctx.env.DB, doc, { source: SOURCE, source_id: doc.sources[0].source_id });
        if (outcome === "unchanged") result.unchanged += 1;
        else result.upserted += 1;
      } catch (err) {
        if (!(err instanceof InvalidAdvisoryError)) throw err;
        result.errors.push(`${doc.sources[0].source_id}: ${err.message}`);
      }
    }
    await kv.put(NODE_CURSOR_KEY, post.published);
  }
  return result;
}

export const nodeRuntime: Ingester = { id: SOURCE, run };
