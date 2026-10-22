// TCS-49: advisoryHref percent-encodes every character outside the unreserved
// set and / : ? = & % #, so any advisory url stays one table cell and a working link.
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advisoryHref, run } from "../../action/check.mjs";
import { json, world, type World } from "./helpers.tcs-33.js";

const FIXTURE = new URL("../fixtures/cli/package-lock.json", import.meta.url);

describe("advisoryHref", () => {
  it.each([
    ['https://e.example/a|b c"d', "https://e.example/a%7Cb%20c%22d"],
    ["https://e.example/x?a=1&b=2#f", "https://e.example/x?a=1&b=2#f"],
    ["https://e.example/%41", "https://e.example/%41"],
    ["https://e.example/é", "https://e.example/%C3%A9"],
    ["https://e.example/-._~AZaz09", "https://e.example/-._~AZaz09"],
    ["https://e.example/(a)[b]<c>'d'*!$,;@+", "https://e.example/%28a%29%5Bb%5D%3Cc%3E%27d%27%2A%21%24%2C%3B%40%2B"],
    ["https://e.example/`\\{}^", "https://e.example/%60%5C%7B%7D%5E"],
    ["https://e.example/a\nb", "https://e.example/a%0Ab"],
    ["https://e.example/😀", "https://e.example/%F0%9F%98%80"],
    ["http://e.example/a", "http://e.example/a"],
  ])("%j -> %j", (url, want) => {
    expect(advisoryHref(url)).toBe(want);
  });

  it.each([["javascript:alert(1)"], ["ftp://x"], [""], [undefined], ["  https://e.example/"]])("%j -> null", (url) => {
    expect(advisoryHref(url)).toBeNull();
  });
});

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("advisory url through run()", () => {
  it("a url with a pipe, a space and a quote is one table cell with a working percent-encoded link", async () => {
    w = await world();
    await copyFile(FIXTURE, join(w.dir, "package-lock.json"));
    const affected = {
      dependency: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
      advisory_id: "tcs_01JA0000000000000000000049",
      severity: { label: "high" },
      exploited: false,
      fixed_in: "4.17.21",
      action: "Upgrade lodash to 4.17.21 or later.",
      url: 'https://e.example/a|b c"d',
    };
    w.check = () => json({ checked: 2, affected: [affected], skipped: [], feed_cursor: 9 });
    expect(await run({ env: w.env, fetch: w.fetch, out: w.out })).toBe(1);
    for (const md of [w.comments[0].body, await w.summary()]) {
      const row = md.split("\n").find((l) => l.includes("lodash") && l.startsWith("|"))!;
      expect(row.split(/(?<!\\)\|/)).toHaveLength(9);
      expect(row).toContain("](https://e.example/a%7Cb%20c%22d)");
    }
  });
});
