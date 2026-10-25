import { describe, expect, it } from "vitest";
import { get } from "./seed.tcs-3";

// TCS-101: the per-repo badge snippet on /docs (through the production entry),
// tests/docs/badge-snippet.tcs-101.test.ts checks README.md and action/README.md.

describe("README badge docs", () => {
  it("D1: /docs shows the badge section, the snippet and the id-token permission", async () => {
    const res = await get("/docs", "198.51.100.103");
    expect(res.status).toBe(200);
    const page = await res.text();
    const h = page.indexOf('<h3 id="readme-badge">README badge</h3>');
    expect(h).toBeGreaterThan(0);
    expect(page.indexOf("[![tocsin](https://tocsin.sh/badge/&lt;owner&gt;/&lt;repo&gt;.svg)](https://tocsin.sh)", h)).toBeGreaterThan(h);
    expect(page.indexOf("id-token: write", h)).toBeGreaterThan(h);
  });
});
