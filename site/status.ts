import { escapeHtml, page } from "./layout";

export interface StatusSource {
  id: string;
  kind: string;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
}

export interface StatusData {
  sources: StatusSource[];
  cursor: number;
}

export function renderStatus(data: StatusData): string {
  const rows = data.sources
    .map(
      (s) =>
        "<tr>" +
        `<td>${escapeHtml(s.id)}</td>` +
        `<td class="nowrap">${s.last_ok_at === null ? "never" : escapeHtml(s.last_ok_at)}</td>` +
        `<td>${s.last_error === null ? "-" : escapeHtml(s.last_error)}</td>` +
        "</tr>",
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
