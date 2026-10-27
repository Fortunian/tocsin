import { describe, expect, it } from "vitest";
import { oauth1Header, oauth1Signature, percentEncode, signatureBaseString } from "../../src/social/oauth1";

// TCS-106: OAuth 1.0a HMAC-SHA1 signing (RFC 5849 section 3.4) with crypto.subtle.

describe("OAuth 1.0a signer", () => {
  it("O1: the OAuth Core 1.0 appendix A.5 vector (RFC 5849 family) signs to tR3+Ty81lMeYAr/Fid0kMTYa/WM=", async () => {
    const params: [string, string][] = [
      ["file", "vacation.jpg"],
      ["size", "original"],
      ["oauth_consumer_key", "dpf43f3p2l4k3l03"],
      ["oauth_token", "nnch734d00sl2jdk"],
      ["oauth_signature_method", "HMAC-SHA1"],
      ["oauth_timestamp", "1191242096"],
      ["oauth_nonce", "kllo9940pd9333jh"],
      ["oauth_version", "1.0"],
    ];
    const base = signatureBaseString("GET", "http://photos.example.net/photos", params);
    expect(base).toBe(
      "GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1191242096%26oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal",
    );
    expect(await oauth1Signature(base, "kd94hf93k423kf44", "pfkkdhi9sl3r4s00")).toBe("tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
  });

  it("O2: percent-encoding follows RFC 3986 unreserved chars", () => {
    expect(percentEncode("Ladies + Gentlemen")).toBe("Ladies%20%2B%20Gentlemen");
    expect(percentEncode("An encoded string!")).toBe("An%20encoded%20string%21");
    expect(percentEncode("Dogs, Cats & Mice")).toBe("Dogs%2C%20Cats%20%26%20Mice");
    expect(percentEncode("☃")).toBe("%E2%98%83");
    expect(percentEncode("a-b._~*'()")).toBe("a-b._~%2A%27%28%29");
  });

  it("O3: the header carries every oauth_* field and the JSON body is not in the base string", async () => {
    const creds = { consumerKey: "ck-fixture", consumerSecret: "cs-fixture", token: "tok-fixture", tokenSecret: "ts-fixture" };
    const h = await oauth1Header("POST", "https://api.x.com/2/tweets", creds, { nonce: "nonce-fixture", timestamp: 1_800_000_000 });
    for (const k of ["oauth_consumer_key", "oauth_nonce", "oauth_signature", "oauth_signature_method", "oauth_timestamp", "oauth_token", "oauth_version"]) {
      expect(h).toMatch(new RegExp(`${k}="[^"]+"`));
    }
    expect(h.startsWith("OAuth ")).toBe(true);
    expect(h).toContain('oauth_signature_method="HMAC-SHA1"');
    // Same request with no body in the signature: the expected value is computed from the oauth params alone.
    const base = signatureBaseString("POST", "https://api.x.com/2/tweets", [
      ["oauth_consumer_key", "ck-fixture"],
      ["oauth_nonce", "nonce-fixture"],
      ["oauth_signature_method", "HMAC-SHA1"],
      ["oauth_timestamp", "1800000000"],
      ["oauth_token", "tok-fixture"],
      ["oauth_version", "1.0"],
    ]);
    const sig = await oauth1Signature(base, "cs-fixture", "ts-fixture");
    expect(h).toContain(`oauth_signature="${percentEncode(sig)}"`);
  });
});
