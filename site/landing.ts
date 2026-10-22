import { command, escapeHtml, page } from "./layout";

// One row of the Latest table, as src/site/data.ts builds and caches it.
export interface LatestRow {
  id: string;
  when: string;
  ecosystem: string;
  component: string;
  cve: string | null;
  severity: string;
  action: string;
}

function latestTable(rows: LatestRow[] | null): string {
  if (rows === null) return `<p class="muted">Latest is not available right now.</p>`;
  if (rows.length === 0) return `<p class="muted">No advisories yet.</p>`;
  const body = rows
    .map((r) => {
      const id = encodeURIComponent(r.id);
      const cve = r.cve
        ? `<a href="/v1/events/cve/${encodeURIComponent(r.cve)}">${escapeHtml(r.cve)}</a>`
        : "-";
      return (
        "<tr>" +
        `<td class="nowrap"><time datetime="${escapeHtml(r.when)}">${escapeHtml(r.when.slice(0, 10))}</time></td>` +
        `<td><a href="/advisories/${id}">${escapeHtml(`${r.ecosystem}/${r.component}`)}</a></td>` +
        `<td class="nowrap">${cve}</td>` +
        `<td>${escapeHtml(r.severity)}</td>` +
        `<td>${escapeHtml(r.action)}</td>` +
        "</tr>"
      );
    })
    .join("\n");
  return `<div class="table"><table>
<thead><tr><th scope="col">when</th><th scope="col">component</th><th scope="col">CVE</th><th scope="col">severity</th><th scope="col">action</th></tr></thead>
<tbody>
${body}
</tbody>
</table></div>`;
}

// The landing copy is the client's final text (TCS-10). Do not reword it.
export function renderLanding(rows: LatestRow[] | null): string {
  const body = `<h1>tocsin</h1>
<p class="tag">Security advisories, built for agents.</p>
<p>Your agent runs on Node, PHP, Python, Go, Rust, Ruby and the packages on top of them. When one of them ships a critical
fix, nothing tells the agent. Tocsin does. One feed. One command.</p>
${command("npx tocsin connect")}
<p>Wires Claude Code, Cursor, Claude Desktop and Codex to the feed in one run.</p>
<p>Or do it by hand:</p>
${command('curl "https://tocsin.sh/v1/events?since=0&min_severity=high"')}
${command('curl "https://tocsin.sh/v1/check?node=24.22.0&php=8.4.26"')}
${command("npx tocsin check")}
<p>MCP: <a href="https://mcp.tocsin.sh/mcp">https://mcp.tocsin.sh/mcp</a></p>
<h2>Latest</h2>
${latestTable(rows)}
<p>Free. No account to read. An API key (free) for watch lists and signed webhooks.</p>
<p>Open source, Apache-2.0. <a href="https://github.com/Fortunian/tocsin">github.com/Fortunian/tocsin</a><br>
<a href="https://cromford.dev">Built with Cromford</a>.</p>`;
  return page("tocsin: security advisories, built for agents", body, { script: true });
}
