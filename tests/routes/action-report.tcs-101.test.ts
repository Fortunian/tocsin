import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_OIDC_ISSUER } from "../../src/lib/github-oidc";
import { AUDIENCE, b64url, claimsFor, clearJwks, makeKey, seedJwks, sign, type Claims, type TestKey } from "./oidc-helpers.tcs-101";

// TCS-101: POST /v1/action/report through the production entry (src/index.ts -> app).
// Each test uses its own owner, so tests share no rows.

let key: TestKey;
let other: TestKey;

beforeAll(async () => {
  key = await makeKey("kid-fixture-1");
  other = await makeKey("kid-fixture-1"); // same kid, another key: a forged signature
});
beforeEach(async () => {
  await seedJwks([key]);
});

interface Row {
  owner: string;
  repo: string;
  ref: string;
  is_default: number;
  is_latest: number;
  affected: number;
  min_severity: string;
  run_id: string;
  reported_at: string;
}

function post(token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.101", ...headers };
  if (token !== null) h.Authorization = `Bearer ${token}`;
  return exports.default.fetch(`https://${AUDIENCE}/v1/action/report`, { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function rows(owner: string): Promise<Row[]> {
  const { results } = await env.DB.prepare("SELECT * FROM action_reports WHERE owner = ? ORDER BY id").bind(owner).all<Row>();
  return results;
}

const body = (repository: string, over: Record<string, unknown> = {}) => ({ repository, affected: 2, min_severity: "high", default_branch: "main", ...over });

async function tokenFor(repository: string, over: Partial<Claims> = {}): Promise<string> {
  return sign(key, claimsFor(repository, over));
}

describe("POST /v1/action/report", () => {
  it("A1: a valid token for acme-a/widget writes one row from the token claims", async () => {
    const res = await post(await tokenFor("acme-a/widget"), body("acme-a/widget"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    const r = await rows("acme-a");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ owner: "acme-a", repo: "widget", ref: "refs/heads/main", is_default: 1, is_latest: 1, affected: 2, min_severity: "high", run_id: "1001" });
    expect(Date.parse(r[0].reported_at)).not.toBeNaN();
  });

  it("A2: a token for acme-b/other with body acme-b/widget is 403 and writes no row (wrong tenant)", async () => {
    const res = await post(await tokenFor("acme-b/other"), body("acme-b/widget"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "token is for another repository" });
    expect(await rows("acme-b")).toHaveLength(0);
  });

  it("A3: the same run_id twice writes one row; the second answer is recorded:false", async () => {
    const t = await tokenFor("acme-dup/widget", { run_id: "7001" });
    expect(await (await post(t, body("acme-dup/widget", { affected: 1 }))).json()).toEqual({ recorded: true });
    const second = await post(t, body("acme-dup/widget", { affected: 9 }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ recorded: false });
    const r = await rows("acme-dup");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ affected: 1, is_latest: 1 });
  });

  it("A4: no Authorization header is 401; Bearer garbage is 401", async () => {
    const none = await post(null, body("acme-none/widget"));
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "missing token" });
    const junk = await post("garbage", body("acme-none/widget"));
    expect(junk.status).toBe(401);
    expect(await junk.json()).toMatchObject({ error: "invalid token" });
    const basic = await post(null, body("acme-none/widget"), { Authorization: "Basic Zml4dHVyZQ==" });
    expect(basic.status).toBe(401);
    expect(await rows("acme-none")).toHaveLength(0);
  });

  describe("A5: the negative list writes no row", () => {
    const now = () => Math.floor(Date.now() / 1000);
    const cases: [string, number, (repo: string) => Promise<[string, unknown]>][] = [
      ["a token signed by another key with the same kid", 401, async (r) => [await sign(other, claimsFor(r)), body(r)]],
      [
        "alg none",
        401,
        async (r) => [`${b64url(JSON.stringify({ alg: "none", typ: "JWT", kid: "kid-fixture-1" }))}.${b64url(JSON.stringify(claimsFor(r)))}.`, body(r)],
      ],
      [
        "alg HS256 signed with the public key as the secret",
        401,
        async (r) => {
          const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "kid-fixture-1" }));
          const p = b64url(JSON.stringify(claimsFor(r)));
          const secret = await crypto.subtle.importKey("raw", new TextEncoder().encode(JSON.stringify(key.jwk)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const sig = new Uint8Array(await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(`${h}.${p}`)));
          return [`${h}.${p}.${b64url(sig)}`, body(r)];
        },
      ],
      ["aud evil.example", 401, async (r) => [await tokenFor(r, { aud: "evil.example" }), body(r)]],
      ["iss with an evil suffix", 401, async (r) => [await tokenFor(r, { iss: `${GITHUB_OIDC_ISSUER}.evil.example` }), body(r)]],
      ["an expired exp", 401, async (r) => [await tokenFor(r, { exp: now() - 3600 }), body(r)]],
      ["an unknown kid", 401, async (r) => [await sign(key, claimsFor(r), { kid: "kid-fixture-unknown" }), body(r)]],
      ["claim acme-x/widget-fork for body acme-x/widget", 403, async (r) => [await tokenFor(`${r}-fork`), body(r)]],
      ["claim acme-evil/widget for body acme-x/widget", 403, async (r) => [await tokenFor(r.replace(/^[^/]+/, "acme-evil")), body(r)]],
      ["a private repository claim", 403, async (r) => [await tokenFor(r, { repository_visibility: "private" }), body(r)]],
      ["affected -1", 400, async (r) => [await tokenFor(r), body(r, { affected: -1 })]],
      ['affected "3"', 400, async (r) => [await tokenFor(r), body(r, { affected: "3" })]],
      ["min_severity bogus", 400, async (r) => [await tokenFor(r), body(r, { min_severity: "bogus" })]],
      ["a body that is not JSON", 400, async (r) => [await tokenFor(r), "{not json"]],
    ];
    cases.forEach(([name, status, make], i) => {
      it(`${name} answers ${status}`, async () => {
        const owner = `acme-neg${i}`;
        const [token, b] = await make(`${owner}/widget`);
        const res = await post(token, b);
        expect(res.status).toBe(status);
        expect(await rows(owner)).toHaveLength(0);
        expect(await rows("acme-evil")).toHaveLength(0);
      });
    });
  });

  it("A6: claim Acme-C/Widget with body acme-c/widget is stored lowercase; aud as an array is accepted", async () => {
    const res = await post(await tokenFor("Acme-C/Widget", { aud: ["other.example", AUDIENCE] }), body("acme-c/widget"));
    expect(res.status).toBe(200);
    const r = await rows("acme-c");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ owner: "acme-c", repo: "widget" });
  });

  it("A7: a second run on the same ref demotes the older row; another ref keeps its latest", async () => {
    const repo = "acme-latest/widget";
    await post(await tokenFor(repo, { run_id: "1" }), body(repo));
    await post(await tokenFor(repo, { run_id: "2", ref: "refs/heads/feature" }), body(repo));
    await post(await tokenFor(repo, { run_id: "3" }), body(repo, { affected: 0 }));
    const r = await rows("acme-latest");
    expect(r.map((x) => [x.run_id, x.ref, x.is_latest, x.is_default])).toEqual([
      ["1", "refs/heads/main", 0, 1],
      ["2", "refs/heads/feature", 1, 0],
      ["3", "refs/heads/main", 1, 1],
    ]);
  });

  it("A8: with no JWKS in KV the fake transport refuses the network: 503 and no row", async () => {
    await clearJwks();
    const res = await post(await tokenFor("acme-nokeys/widget"), body("acme-nokeys/widget"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "oidc keys unavailable" });
    expect(await rows("acme-nokeys")).toHaveLength(0);
  });

  it("A9: the token's ref and run_id win over any body field of the same name", async () => {
    const repo = "acme-body/widget";
    const res = await post(await tokenFor(repo, { run_id: "55", ref: "refs/heads/dev" }), body(repo, { ref: "refs/heads/main", run_id: "999" }));
    expect(res.status).toBe(200);
    const r = await rows("acme-body");
    expect(r.map((x) => [x.ref, x.run_id, x.is_default])).toEqual([["refs/heads/dev", "55", 0]]);
  });

  it("A10: a run with default_branch null keeps the ref's is_default; a first run with null is not default", async () => {
    const repo = "acme-nulldef/widget";
    await post(await tokenFor(repo, { run_id: "1" }), body(repo, { affected: 0 }));
    await post(await tokenFor(repo, { run_id: "2" }), body(repo, { affected: 5, default_branch: null }));
    await post(await tokenFor(repo, { run_id: "3", ref: "refs/heads/feature" }), body(repo, { default_branch: null }));
    await post(await tokenFor(repo, { run_id: "4", ref: "refs/heads/feature" }), body(repo, { default_branch: null }));
    const r = await rows("acme-nulldef");
    expect(r.map((x) => [x.run_id, x.ref, x.is_latest, x.is_default, x.affected])).toEqual([
      ["1", "refs/heads/main", 0, 1, 0],
      ["2", "refs/heads/main", 1, 1, 5],
      ["3", "refs/heads/feature", 0, 0, 2],
      ["4", "refs/heads/feature", 1, 0, 2],
    ]);
  });
});

