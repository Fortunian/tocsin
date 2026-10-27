// OAuth 1.0a request signing, HMAC-SHA1 (RFC 5849 section 3.4), with
// crypto.subtle and no npm dependency. Used only by the X seam (src/social/x.ts).
// A JSON request body is not form-encoded, so it is not part of the base string.

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding (RFC 5849 section 3.6): only A-Z a-z 0-9 - . _ ~ stay. */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The signature base string (RFC 5849 section 3.4.1). `url` has no query; pass query params in `params`. */
export function signatureBaseString(method: string, url: string, params: [string, string][]): string {
  const normalized = params
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(normalized)}`;
}

/** HMAC-SHA1 of the base string under "<consumer secret>&<token secret>", base64. */
export async function oauth1Signature(base: string, consumerSecret: string, tokenSecret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(`${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(base)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The Authorization header value for one request. `nonce` and `timestamp` are for tests only. */
export async function oauth1Header(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  opts: { nonce?: string; timestamp?: number } = {},
): Promise<string> {
  const oauth: [string, string][] = [
    ["oauth_consumer_key", creds.consumerKey],
    ["oauth_nonce", opts.nonce ?? randomNonce()],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", String(opts.timestamp ?? Math.floor(Date.now() / 1000))],
    ["oauth_token", creds.token],
    ["oauth_version", "1.0"],
  ];
  const signature = await oauth1Signature(signatureBaseString(method, url, oauth), creds.consumerSecret, creds.tokenSecret);
  const fields = [...oauth, ["oauth_signature", signature] as [string, string]].sort(([a], [b]) => (a < b ? -1 : 1));
  return `OAuth ${fields.map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`).join(", ")}`;
}
