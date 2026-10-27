// The selection rule of the social lane (TCS-106). Pure: no I/O.
import { isGoToolchainAdvisory } from "../check/go-runtime";
import type { Advisory } from "../schema/advisory";
import { SEVERITY_RANK, type SocialConfig } from "./config";

// The token in social.x.sources for OSV Go rows on the Go toolchain. A plain
// `osv` entry would admit every OSV ecosystem.
export const GO_TOOLCHAIN_TOKEN = "osv-go-toolchain";

// The advisories ecosystem each source token stores its rows under. A token
// not in this map has no rows to scan and is ignored.
export const SOURCE_ECOSYSTEMS: Record<string, string> = {
  "node-runtime": "node",
  "php-runtime": "php",
  "python-runtime": "python",
  "deno-runtime": "deno",
  "bun-runtime": "bun",
  [GO_TOOLCHAIN_TOKEN]: "Go",
};

/** The distinct ecosystems the configured sources store their rows under. */
export function ecosystemsFor(sources: string[]): string[] {
  return [...new Set(sources.map((s) => SOURCE_ECOSYSTEMS[s]).filter((e): e is string => e !== undefined))];
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The ms time of a `tcs_<ULID>` advisory id (src/ingest/ulid.ts), or null. */
export function ulidTime(id: string): number | null {
  if (!/^tcs_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  let t = 0;
  for (const ch of id.slice(4, 14)) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

/** True when the stored doc carries a non-empty withdrawn value. */
export function isWithdrawn(doc: object): boolean {
  const w = (doc as { withdrawn?: unknown }).withdrawn;
  return w !== undefined && w !== null && w !== "" && w !== false;
}

function sourceListed(doc: Advisory, sources: string[]): boolean {
  if (doc.sources.some((s) => sources.includes(s.source))) return true;
  return sources.includes(GO_TOOLCHAIN_TOKEN) && doc.sources.some((s) => s.source === "osv") && isGoToolchainAdvisory(doc);
}

/**
 * An advisory qualifies once, when all hold: a listed source; severity at or
 * above min_severity; first sight (its id was minted at or after the previous
 * scan, so an update to an older advisory never qualifies); published within
 * max_age_hours; not withdrawn.
 */
export function qualifies(doc: Advisory, cfg: SocialConfig, prevScanAt: string, now: Date): boolean {
  if (!sourceListed(doc, cfg.sources)) return false;
  if (SEVERITY_RANK[doc.severity.label] < SEVERITY_RANK[cfg.minSeverity]) return false;
  const minted = ulidTime(doc.id);
  const prev = Date.parse(prevScanAt);
  if (minted === null || Number.isNaN(prev) || minted < prev) return false;
  const published = Date.parse(doc.published_at);
  if (Number.isNaN(published) || now.getTime() - published > cfg.maxAgeHours * 3_600_000) return false;
  return !isWithdrawn(doc);
}
