// The "Codex" section on /docs, through the production entry (src/index.ts -> app).
import { describe, expect, it } from "vitest";
import { get } from "./seed.tcs-3";

describe("/docs Codex section", () => {
  it("shows the Codex heading, the --codex command and the AGENTS.md block", async () => {
    const res = await get("/docs", "198.51.100.28");
    expect(res.status).toBe(200);
    const page = await res.text();
    const heading = page.indexOf('<h3 id="codex">Codex</h3>');
    expect(heading).toBeGreaterThan(0);
    const cmd = page.indexOf("<pre><code>npx tocsin connect --codex</code></pre>");
    expect(cmd).toBeGreaterThan(heading);
    const agents = page.indexOf("## Security advisories (Tocsin)", heading);
    expect(agents).toBeGreaterThan(heading);
    expect(page.indexOf("npx tocsin check --json", agents)).toBeGreaterThan(agents);
    // The install links still follow the plain connect block, not the Codex one.
    const connect = page.indexOf("<pre><code>npx tocsin connect</code></pre>");
    const cursorLink = page.indexOf(">Add to Cursor</a>");
    expect(connect).toBeGreaterThan(0);
    expect(cursorLink).toBeGreaterThan(connect);
    expect(cursorLink).toBeLessThan(heading);
  });
});
