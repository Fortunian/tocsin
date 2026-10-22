import type { EventsFilters } from "./query";

// Strong ETag over the page's identity: the last cursor in the page, whether
// more rows follow, and every filter. Two different pages never share a tag.
export async function eventsEtag(f: EventsFilters, nextCursor: number, hasMore: boolean): Promise<string> {
  const canonical = JSON.stringify({
    max: nextCursor,
    has_more: hasMore,
    since: f.since,
    limit: f.limit,
    ecosystem: [...f.ecosystem].sort(),
    component: [...f.component].sort(),
    min_severity: f.min_severity,
    exploited: f.exploited,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex.slice(0, 32)}"`;
}

// If-None-Match uses weak comparison (RFC 9110 13.1.2): a W/ prefix still matches.
export function ifNoneMatchHits(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === etag);
}
