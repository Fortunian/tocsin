import { describe, expect, it } from "vitest";
import { normalizeNodePost } from "../../src/ingest/node-runtime";
import decHtml from "../fixtures/node-runtime/2026-01-13-incomplete.html?raw";
import juneHtml from "../fixtures/node-runtime/2026-06-18.html?raw";

// TCS-76 reproduction. It imports only modules and fixtures that exist before
// the fix, so it runs (and fails) at the merge base too. The two RECORDED posts
// (tests/fixtures/node-runtime/README.tcs-69.md) against a dist set of the
// versions the posts name; each one is in the 2026-10-22 dist index
// recording (tests/fixtures/node-runtime/README.tcs-76.md).
const BASE = "https://nodejs.org/en/blog/vulnerability/";
const DIST = new Set(["v22.23.0", "v24.17.0", "v26.3.1", "v20.20.0", "v22.22.0", "v24.12.0", "v24.13.0", "v25.3.0"]);

describe("TCS-76 repro", () => {
  it("R1: the June 2026 post gives 12 advisories", () => {
    const n = normalizeNodePost({ link: `${BASE}june-2026-security-releases`, published: "2026-06-18T04:00:00.000Z" }, juneHtml, DIST);
    expect(n.incomplete).toBe(false);
    expect(n.notEmitted).toBe(0);
    expect(n.docs).toHaveLength(12);
  });

  it("R2: the December 2025 post is complete and gives 8 advisories", () => {
    const n = normalizeNodePost({ link: `${BASE}december-2025-security-releases`, published: "2026-01-13T00:00:00.000Z" }, decHtml, DIST);
    expect(n.errors).toEqual([]);
    expect(n.incomplete).toBe(false);
    expect(n.docs).toHaveLength(8);
  });
});
