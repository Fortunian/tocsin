import type { LedgerCounts } from "../src/ingest/ledgers";
import { escapeHtml, page } from "./layout";

export interface StatusSource {
  id: string;
  kind: string;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_warning: string | null;
  // Only on a source with a ledger table, and only from loadStatus({ ledger: true }).
  ledger?: LedgerCounts;
}

export interface StatusData {
  sources: StatusSource[];
  cursor: number;
}

// Plain text under the source row; the counts link to nothing yet.
function subRow(s: StatusSource): string {
  const parts: string[] = [];
  if (s.ledger) {
    const l = s.ledger;
    parts.push(`ledger: ok ${l.ok} · empty ${l.empty} · pending ${l.pending} · failed, retrying ${l.failed_retrying} · failed, terminal ${l.failed_terminal}`);
  }
  if (s.last_warning !== null) parts.push(`last warning: ${escapeHtml(s.last_warning)}`);
  return parts.length ? `\n<tr class="sub"><td></td><td colspan="2" class="muted">${parts.join("<br>")}</td></tr>` : "";
}

export function renderStatus(data: StatusData): string {
  const rows = data.sources
    .map(
      (s) =>
        "<tr>" +
        `<td>${escapeHtml(s.id)}</td>` +
        `<td class="nowrap">${s.last_ok_at === null ? "never" : escapeHtml(s.last_ok_at)}</td>` +
        `<td>${s.last_error === null ? "-" : escapeHtml(s.last_error)}</td>` +
        "</tr>" +
        subRow(s),
    )
    .join("\n");
  const table = data.sources.length
    ? `<div class="table"><table>
<thead><tr><th scope="col">source</th><th scope="col">last ok</th><th scope="col">last error</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`
    : `<p class="muted">No enabled sources.</p>`;
  const body = `<h1>tocsin status</h1>
<p>Each enabled source, the time of its last good run, and its last error. JSON: <a href="/v1/status">/v1/status</a>.</p>
${table}
<p>Newest cursor: <code>${data.cursor}</code></p>`;
  return page("tocsin status", body);
}
