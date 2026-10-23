import type { LedgerCounts } from "../src/ingest/ledgers";
import { escapeHtml, page } from "./layout";

export interface StatusSource {
  id: string;
  kind: string;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_warning: string | null;
  // The oldest published_at the source holds; NULL until its history is read in full (TCS-32).
  coverage_since: string | null;
  // Only on a source with a ledger table, and only from loadStatus({ ledger: true }).
  ledger?: LedgerCounts;
}

// One row per enabled OSV ecosystem and per runtime. `imported` is null for a runtime.
export interface CoverageRow {
  ecosystem: string;
  since: string | null;
  complete: boolean;
  imported: number | null;
}

export interface StatusData {
  sources: StatusSource[];
  cursor: number;
  // Only from loadStatus({ coverage: true }).
  coverage?: CoverageRow[];
}

// Plain text under the source row; the counts link to nothing yet.
function subRow(s: StatusSource): string {
  const parts: string[] = [];
  if (s.ledger) {
    const l = s.ledger;
    parts.push(`ledger: ok ${l.ok} · empty ${l.empty} · pending ${l.pending} · failed, retrying ${l.failed_retrying} · failed, terminal ${l.failed_terminal}`);
  }
  if (s.last_warning !== null) parts.push(`last warning: ${escapeHtml(s.last_warning)}`);
  return parts.length ? `\n<tr class="sub"><td></td><td colspan="3" class="muted">${parts.join("<br>")}</td></tr>` : "";
}

// Per ecosystem: since when Tocsin holds its advisories and whether that
// history is complete. A check in a partial ecosystem reports partial_coverage.
function coverageTable(rows: CoverageRow[] | undefined): string {
  if (rows === undefined) return "";
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.ecosystem)}</td><td class="nowrap">${r.since === null ? "-" : escapeHtml(r.since)}</td>` +
        `<td>${r.complete ? "complete" : "partial"}</td><td>${r.imported === null ? "-" : r.imported}</td></tr>`,
    )
    .join("\n");
  return `<h2>Coverage</h2>
<p>Per ecosystem: the oldest advisory Tocsin holds and whether its history is complete. A dependency with no finding in a partial ecosystem is reported as <code>partial_coverage</code>, not as clean.</p>
<div class="table"><table>
<thead><tr><th scope="col">ecosystem</th><th scope="col">since</th><th scope="col">history</th><th scope="col">records</th></tr></thead>
<tbody>
${body}
</tbody>
</table></div>`;
}

export function renderStatus(data: StatusData): string {
  const rows = data.sources
    .map(
      (s) =>
        "<tr>" +
        `<td>${escapeHtml(s.id)}</td>` +
        `<td class="nowrap">${s.last_ok_at === null ? "never" : escapeHtml(s.last_ok_at)}</td>` +
        `<td class="nowrap">${s.coverage_since === null ? "-" : escapeHtml(s.coverage_since)}</td>` +
        `<td>${s.last_error === null ? "-" : escapeHtml(s.last_error)}</td>` +
        "</tr>" +
        subRow(s),
    )
    .join("\n");
  const table = data.sources.length
    ? `<div class="table"><table>
<thead><tr><th scope="col">source</th><th scope="col">last ok</th><th scope="col">coverage since</th><th scope="col">last error</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`
    : `<p class="muted">No enabled sources.</p>`;
  const body = `<h1>tocsin status</h1>
<p>Each enabled source, the time of its last good run, the oldest advisory it holds once its history is read in full, and its last error. JSON: <a href="/v1/status">/v1/status</a>.</p>
${table}
${coverageTable(data.coverage)}
<p>Newest cursor: <code>${data.cursor}</code></p>`;
  return page("tocsin status", body);
}
