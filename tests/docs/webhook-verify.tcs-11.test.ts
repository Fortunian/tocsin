// TCS-11 round 2, finding 2: replay. Runs in plain Node. It takes the
// receiver verification code block from docs/API.md ("Verify a delivery") as
// written, and checks it against headers made by the real signer
// (src/queue/sign.ts). A replayed body with a fresh timestamp must not verify.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signatureHeaders } from "../../src/queue/sign";

type Verify = (secret: string, headers: Record<string, string>, rawBody: string, nowSeconds?: number) => Promise<boolean>;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const API_MD = readFileSync(resolve(root, "docs/API.md"), "utf8");

// The first ```js block after the "### Verify a delivery" heading.
function documentedVerify(): Verify {
  const at = API_MD.indexOf("### Verify a delivery");
  if (at < 0) throw new Error('docs/API.md has no "### Verify a delivery" section');
  const m = /```js\n([\s\S]*?)\n```/.exec(API_MD.slice(at));
  if (!m) throw new Error("no ```js block after the heading");
  return new Function(`${m[1]}\nreturn verifyTocsinWebhook;`)() as Verify;
}

const SECRET = "whsec_" + "ab".repeat(32);
const BODY = JSON.stringify({ id: "tcs_DOCFIXTURE", summary: "doc fixture" });
const T = 1_792_000_000;

async function headersAt(ts: number, body = BODY, secret = SECRET): Promise<Record<string, string>> {
  const h = await signatureHeaders(secret, body, ts);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

describe("the documented receiver check (docs/API.md)", () => {
  const verify = documentedVerify();

  it("verifies a fresh delivery made by the real signer", async () => {
    const h = await headersAt(T);
    expect(h["tocsin-timestamp"]).toBe(String(T));
    expect(h["tocsin-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(await verify(SECRET, h, BODY, T)).toBe(true);
    expect(await verify(SECRET, h, BODY, T + 299)).toBe(true);
  });

  it("refuses a replayed body and signature under a fresh timestamp", async () => {
    const old = await headersAt(T);
    const replay = { ...old, "tocsin-timestamp": String(T + 3600) };
    expect(await verify(SECRET, replay, BODY, T + 3600)).toBe(false);
  });

  it("refuses the same capture replayed after the 5-minute tolerance", async () => {
    const old = await headersAt(T);
    expect(await verify(SECRET, old, BODY, T + 301)).toBe(false);
    expect(await verify(SECRET, old, BODY, T - 301)).toBe(false);
  });

  it("refuses a changed body, a wrong secret and missing headers", async () => {
    const h = await headersAt(T);
    expect(await verify(SECRET, h, BODY + " ", T)).toBe(false);
    expect(await verify("whsec_wrong", h, BODY, T)).toBe(false);
    expect(await verify(SECRET, { "tocsin-timestamp": String(T) }, BODY, T)).toBe(false);
    expect(await verify(SECRET, { ...h, "tocsin-timestamp": "x" }, BODY, T)).toBe(false);
  });
});
