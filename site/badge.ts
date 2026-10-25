import { escapeHtml } from "./layout";

// Flat two-part SVG badges: the feed badge /badge/status.svg (TCS-35) and the
// per-repo badge /badge/<owner>/<repo>.svg (TCS-101).

export const GREEN = "#2e9e44";
export const RED = "#e05d44";
export const GREY = "#9f9f9f";

// Approximate Verdana 11px advance per character, the shields.io convention.
function textWidth(s: string): number {
  return Math.round(s.length * 6.5) + 12;
}

// "label | value": a grey label part and a coloured value part. Deterministic:
// the same input gives the same bytes.
export function flatBadge(label: string, value: string, color: string, title: string): string {
  const lw = textWidth(label);
  const vw = textWidth(value);
  const w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${escapeHtml(title)}">
<title>${escapeHtml(title)}</title>
<rect width="${lw}" height="20" fill="#555"/>
<rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${label}</text>
<text x="${lw + vw / 2}" y="14">${escapeHtml(value)}</text>
</g>
</svg>
`;
}

export interface RepoReport {
  affected: number;
  min_severity: string;
  reported_at: string;
}

// The per-repo badge: "unknown" (no report), "clean" (0 affected) or
// "N affected". The title carries the severity floor and the report date.
// `unavailable` is the failed-read state, never shown as "unknown".
export function renderRepoBadge(r: RepoReport | null | "unavailable"): string {
  const label = "tocsin";
  if (r === "unavailable") return flatBadge(label, "unavailable", GREY, `${label} · unavailable`);
  if (r === null) return flatBadge(label, "unknown", GREY, `${label} · unknown (no report yet)`);
  const value = r.affected === 0 ? "clean" : `${r.affected} affected`;
  const title = `${label} · ${value} (${r.min_severity} or above, ${r.reported_at.slice(0, 10)})`;
  return flatBadge(label, value, r.affected === 0 ? GREEN : RED, title);
}
