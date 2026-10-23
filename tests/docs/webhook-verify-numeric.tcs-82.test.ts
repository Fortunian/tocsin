// TCS-82 item 7 (comment 6373816984): the documented receiver code refuses a
// Tocsin-Timestamp that is not all digits. Runs in plain Node against the
// ```js block of docs/API.md "Verify a delivery", with a signature that the
// real signer (src/queue/sign.ts) made over that same timestamp string, and a
// clock set to Number(timestamp) where that is a number: only the digit rule
// can refuse these.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signPayload } from "../../src/queue/sign";

type Verify = (secret: string, headers: Record<string, string>, rawBody: string, nowSeconds?: number) => Promise<boolean>;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const API_MD = readFileSync(resolve(root, "docs/API.md"), "utf8");

function documentedVerify(): Verify {
  const at = API_MD.indexOf("### Verify a delivery");
  if (at < 0) throw new Error('docs/API.md has no "### Verify a delivery" section');
  const m = /```js\n([\s\S]*?)\n```/.exec(API_MD.slice(at));
  if (!m) throw new Error("no ```js block after the heading");
  return new Function(`${m[1]}\nreturn verifyTocsinWebhook;`)() as Verify;
}

const SECRET = "whsec_" + "cd".repeat(32);
const BODY = JSON.stringify({ id: "tcs_DOCFIXTURE82", summary: "doc fixture" });

describe("the documented receiver check refuses a non-numeric Tocsin-Timestamp", () => {
  const verify = documentedVerify();

  it("a digit timestamp signed the same way verifies (control)", async () => {
    const ts = "1792000000";
    const sig = await signPayload(SECRET, ts as unknown as number, BODY);
    expect(await verify(SECRET, { "tocsin-timestamp": ts, "tocsin-signature": sig }, BODY, 1_792_000_000)).toBe(true);
  });

  for (const ts of ["abc", "NaN", "1e9", "-1", "12.5", "", " 1792000000", "0x6ad0c400"]) {
    it(`refuses Tocsin-Timestamp ${JSON.stringify(ts)}`, async () => {
      // The real signer, over the same string the receiver reads.
      const sig = await signPayload(SECRET, ts as unknown as number, BODY);
      const n = Number(ts);
      const now = Number.isFinite(n) ? n : 1_792_000_000;
      expect(await verify(SECRET, { "tocsin-timestamp": ts, "tocsin-signature": sig }, BODY, now)).toBe(false);
    });
  }
});
