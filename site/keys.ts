import { command, escapeHtml, page } from "./layout";

// The pages of the mailed key link (TCS-64). GET shows the confirm page and
// writes nothing; only the form POST spends the token and shows the key.

const REQUEST_AGAIN = `<p>Request a new link with <code>POST /v1/keys</code> and <code>{"email": "you@example.com"}</code>. See <a href="/docs">the docs</a>.</p>`;

export function renderConfirmPage(token: string, replaces: boolean): string {
  const effect = replaces
    ? "Press Confirm to replace the API key of this email. The old key stops working when you press it."
    : "Press Confirm to make your API key. We show it once, on the next page.";
  return page(
    "Confirm your Tocsin key",
    `<h1>Confirm your Tocsin key</h1>
<p>${effect}</p>
<form method="post" action="/v1/keys/confirm">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit" class="primary">Confirm</button>
</form>
<p class="muted">If you did not ask for this, close this page. Nothing changes until you press Confirm.</p>`,
  );
}

// One page for every link that cannot be confirmed: used, expired, unknown or
// malformed. It names nothing about the email or the key.
export function renderLinkGonePage(): string {
  return page("Tocsin key link", `<h1>Tocsin key link</h1>\n<p>This link is used or expired.</p>\n${REQUEST_AGAIN}`);
}

export function renderKeyPage(key: string, replaced: boolean): string {
  const note = replaced ? "<p>The old key of this email no longer works.</p>" : "";
  return page(
    "Your Tocsin key",
    `<h1>Your Tocsin key</h1>
<p>Copy it now. We store only its SHA-256, so we cannot show it again.</p>
${command(key)}
${note}
<p>Send it as <code>Authorization: Bearer &lt;key&gt;</code>. See <a href="/docs">the docs</a>.</p>`,
    { script: true },
  );
}
