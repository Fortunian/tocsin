// The HTML shell every site page shares: inline CSS, no external asset, and
// the one inline script (the copy buttons).

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root { --bg: #0b0d10; --fg: #e6e8eb; --muted: #9aa3ad; --line: #232830; --code: #12161b; --accent: #ff8a3d; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 16px; line-height: 1.55; }
main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 48px; }
h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: 0.02em; }
h2 { font-size: 20px; margin: 32px 0 8px; }
h3 { font-size: 17px; margin: 24px 0 6px; }
p { margin: 12px 0; }
p, li { overflow-wrap: anywhere; }
a { color: var(--accent); }
.tag { font-size: 20px; margin: 0 0 20px; }
code, pre, .cmd code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; }
code { background: var(--code); padding: 1px 4px; border-radius: 4px; }
pre { background: var(--code); border: 1px solid var(--line); border-radius: 6px; padding: 12px; overflow-x: auto; }
pre code { background: none; padding: 0; }
.cmd { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.cmd pre { flex: 1 1 auto; min-width: 0; margin: 0; }
button[data-copy] { flex: 0 0 auto; min-height: 40px; min-width: 64px; padding: 0 12px; border: 1px solid var(--accent); border-radius: 6px; background: transparent; color: var(--accent); font: inherit; cursor: pointer; }
button[data-copy]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.table { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td.nowrap { white-space: nowrap; }
.muted { color: var(--muted); }
footer { margin-top: 40px; color: var(--muted); }
`;

// Binds every button[data-copy] to the clipboard. No other script on the site.
const COPY_JS = `document.querySelectorAll("button[data-copy]").forEach(function (b) {
  b.addEventListener("click", function () {
    navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function () {
      var t = b.textContent; b.textContent = "Copied";
      setTimeout(function () { b.textContent = t; }, 1500);
    });
  });
});`;

// `head` is trusted markup the caller built (canonical link, JSON-LD); it goes in as is.
export function page(title: string, body: string, opts: { script?: boolean; head?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
${opts.head ? `${opts.head}\n` : ""}</head>
<body>
<main>
${body}
<footer><a href="/docs">docs</a> · <a href="/status">status</a> · <a href="/llms.txt">llms.txt</a><br>Created with ❤️ by <a href="https://www.linkedin.com/in/liorweinstein">Lior Weinstein</a>.</footer>
</main>
${opts.script ? `<script>${COPY_JS}</script>\n` : ""}</body>
</html>
`;
}

// One command line with its copy button. `data-copy` holds the raw command.
export function command(cmd: string): string {
  const e = escapeHtml(cmd);
  return `<div class="cmd"><pre><code>${e}</code></pre><button type="button" data-copy="${e}" aria-label="Copy: ${e}">Copy</button></div>`;
}
