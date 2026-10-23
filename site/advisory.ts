import type { Advisory } from "../src/schema/advisory";
import { command, escapeHtml, page } from "./layout";

// One HTML page per advisory (/advisories/<id>) and per CVE (/cve/<CVE>).
// Every value on the page comes from the advisory record; nothing is guessed.

export const SITE_BASE = "https://tocsin.sh";

export const advisoryPath = (id: string) => `/advisories/${encodeURIComponent(id)}`;
export const cvePath = (cve: string) => `/cve/${encodeURIComponent(cve)}`;

// The upgrade line per package ecosystem, the same table as the GitHub Action
// (TCS-33). A runtime (node, php, ...) has no package-manager command: the
// page shows the advisory's action line only.
const UPGRADE: Record<string, (pkg: string, v: string) => string> = {
  npm: (p, v) => `npm i ${p}@${v}`,
  PyPI: (p, v) => `pip install ${p}==${v}`,
  // OSV stores Go versions without the "v" that go get needs.
  Go: (p, v) => `go get ${p}@${v.startsWith("v") ? v : `v${v}`}`,
  Packagist: (p, v) => `composer require ${p}:${v}`,
  "crates.io": (p, v) => `cargo update -p ${p} --precise ${v}`,
  RubyGems: (p) => `bundle update ${p}`,
};

// OSV's Go entries for the Go distribution itself: no module to go get.
const isGoToolchain = (a: Advisory) =>
  a.ecosystem === "Go" && (a.component === "stdlib" || a.component === "toolchain" || a.component.startsWith("cmd/"));

// One command per fixed version, deduplicated (bundle takes no version).
export function upgradeCommands(a: Advisory): string[] {
  const fn = UPGRADE[a.ecosystem];
  if (!fn || isGoToolchain(a)) return [];
  return [...new Set(a.fixed_versions.map((v) => fn(a.component, v)))];
}

// A fix in the Go distribution is an upgrade of Go itself, not a command.
function goToolchainLines(a: Advisory): string[] {
  if (!isGoToolchain(a)) return [];
  return [...new Set(a.fixed_versions.map((v) => `<p>Upgrade Go to ${escapeHtml(v.replace(/^v/, ""))}.</p>`))];
}

function severityText(a: Advisory): string {
  return a.severity.score === undefined ? a.severity.label : `${a.severity.label} ${a.severity.score}`;
}

// "npm/left-pad CVE-2026-1: critical 9.8, exploited, EPSS 45.67%"
export function advisoryTitle(a: Advisory): string {
  const parts = [severityText(a)];
  if (a.exploited) parts.push("exploited");
  if (a.epss !== undefined) parts.push(`EPSS ${(a.epss * 100).toFixed(2)}%`);
  const cve = a.cve_ids.length ? ` ${a.cve_ids.join(", ")}` : "";
  return `${a.ecosystem}/${a.component}${cve}: ${parts.join(", ")}`;
}

function time(iso: string): string {
  const e = escapeHtml(iso);
  return `<time datetime="${e}">${e}</time>`;
}

function affectedTable(a: Advisory): string {
  if (a.affected.length === 0) return `<p class="muted">No affected ranges in the source.</p>`;
  const cell = (v: string | undefined) => `<td>${v === undefined ? "-" : escapeHtml(v)}</td>`;
  const rows = a.affected.map((r) => `<tr>${cell(r.introduced)}${cell(r.fixed)}${cell(r.last_affected)}</tr>`).join("\n");
  return `<div class="table"><table>
<thead><tr><th scope="col">introduced</th><th scope="col">fixed</th><th scope="col">last affected</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

function fixedList(a: Advisory): string {
  if (a.fixed_versions.length === 0) return `<p class="muted">No fixed version in the source.</p>`;
  return `<div class="table"><table><tbody><tr>${a.fixed_versions.map((v) => `<td>${escapeHtml(v)}</td>`).join("")}</tr></tbody></table></div>`;
}

function sourcesList(a: Advisory): string {
  const items = a.sources.map(
    (s) => `<li>${escapeHtml(s.source)}: <a href="${escapeHtml(s.url)}">${escapeHtml(s.source_id)}</a></li>`,
  );
  const refs = a.references
    .filter((r) => !a.sources.some((s) => s.url === r))
    .map((r) => `<li><a href="${escapeHtml(r)}">${escapeHtml(r)}</a></li>`);
  return `<ul>\n${[...items, ...refs].join("\n")}\n</ul>`;
}

// The advisory body without the page shell; the CVE page stacks several.
// `level` is the heading level of the advisory title (1 on its own page).
export function advisorySection(a: Advisory, level: 1 | 2): string {
  const h = `h${level}`;
  const sub = `h${level + 1}`;
  const title = escapeHtml(advisoryTitle(a));
  const heading = level === 1 ? title : `<a href="${advisoryPath(a.id)}">${title}</a>`;
  const cmds = upgradeCommands(a);
  const cves = a.cve_ids.map((c) => `<a href="${cvePath(c)}">${escapeHtml(c)}</a>`).join(", ");
  return `<section>
<${h}>${heading}</${h}>
<p>${escapeHtml(a.summary)}</p>
<p><strong>Action:</strong> ${escapeHtml(a.action)}</p>
${[...cmds.map(command), ...goToolchainLines(a)].join("\n")}
<${sub}>Affected</${sub}>
${affectedTable(a)}
<${sub}>Fixed versions</${sub}>
${fixedList(a)}
<${sub}>Sources</${sub}>
${sourcesList(a)}
<p class="muted">${cves ? `${cves} · ` : ""}published ${time(a.published_at)} · modified ${time(a.modified_at)} · <a href="/v1/events/${encodeURIComponent(a.id)}">JSON</a></p>
</section>`;
}

// JSON-LD in a <script>: escape "<" so no value can close the element.
export function jsonLd(data: object): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

function headFor(path: string, ld: object): string {
  return `<link rel="canonical" href="${SITE_BASE}${escapeHtml(path)}">\n${jsonLd(ld)}`;
}

function article(a: Advisory, path: string): object {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: advisoryTitle(a),
    description: a.summary,
    url: `${SITE_BASE}${path}`,
    datePublished: a.published_at,
    dateModified: a.modified_at,
    about: a.cve_ids,
    publisher: { "@type": "Organization", name: "Tocsin", url: SITE_BASE },
  };
}

export function renderAdvisoryPage(a: Advisory): string {
  const path = advisoryPath(a.id);
  const opts = { script: upgradeCommands(a).length > 0, head: headFor(path, article(a, path)) };
  return page(`${advisoryTitle(a)} | tocsin`, `<p><a href="/">tocsin</a></p>\n${advisorySection(a, 1)}`, opts);
}

// One CVE, every advisory that carries it (one per package), oldest first.
export function renderCvePage(cve: string, list: Advisory[]): string {
  const path = cvePath(cve);
  const newest = list.reduce((m, a) => (a.modified_at > m ? a.modified_at : m), list[0].modified_at);
  const ld = { ...article(list[0], path), headline: `${cve}: ${list.length} advisories`, dateModified: newest };
  const body = `<p><a href="/">tocsin</a></p>
<h1>${escapeHtml(cve)}</h1>
<p>${list.length} ${list.length === 1 ? "advisory" : "advisories"}.</p>
${list.map((a) => advisorySection(a, 2)).join("\n")}`;
  const script = list.some((a) => upgradeCommands(a).length > 0);
  return page(`${cve} | tocsin`, body, { script, head: headFor(path, ld) });
}

export function renderNotFound(what: string): string {
  return page("Not found | tocsin", `<h1>${escapeHtml(what)} not found</h1>\n<p><a href="/">Back to the latest advisories</a>.</p>`);
}
