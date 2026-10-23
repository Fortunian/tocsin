import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFakeOutbox } from "../../src/mail/fake";
import { call, nextIp, sha256HexOf, uniqueEmail } from "./keys-helpers.tcs-8";

// TCS-64: POST /v1/keys sends a one-time link; the key is shown only when the
// link is opened. Every request goes through the production entry point.

const LINK_RE = /https:\/\/tocsin\.sh\/v1\/keys\/confirm\?token=(tct_[0-9a-f]{64})/;

const SEEDS: Record<string, string> = {
  "keys.confirm_ttl_seconds": "3600",
  "keys.ip_sends_per_hour": "10",
  "keys.email_sends_per_hour": "3",
  "mail.daily_send_cap": "500",
  "mail.provider": "mailchannels",
  "mail.from_address": "keys@tocsin.sh",
  "keys.confirm_base_url": "https://tocsin.sh",
};

async function setSetting(key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

async function rowsFor(email: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM api_keys WHERE email = ?").bind(email).all<Record<string, unknown>>();
  return results;
}

async function outbox(email: string) {
  return readFakeOutbox(env.CURSORS, email);
}

async function lastToken(email: string): Promise<string> {
  const mails = await outbox(email);
  const m = LINK_RE.exec(mails[mails.length - 1]?.text ?? "");
  if (!m) throw new Error(`no confirm link in the outbox of ${email}`);
  return m[1];
}

async function tokenCount(): Promise<number> {
  return (await env.CURSORS.list({ prefix: "keyconfirm:v1:" })).keys.length;
}

// The mailed link: GET shows the confirm page and must write nothing.
function openLink(token: string, ip?: string): Promise<Response> {
  return call("GET", `/v1/keys/confirm?token=${encodeURIComponent(token)}`, { ip });
}

// The Confirm button (or an agent): POST consumes the token once.
function confirm(token: string, ip?: string): Promise<Response> {
  return call("POST", "/v1/keys/confirm", { ip, body: { token } });
}

function confirmForm(token: string, headers: Record<string, string> = {}): Promise<Response> {
  return call("POST", "/v1/keys/confirm", {
    rawBody: new URLSearchParams({ token }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
  });
}

async function hasToken(token: string): Promise<boolean> {
  return (await env.CURSORS.get(`keyconfirm:v1:${await sha256HexOf(token)}`)) !== null;
}

async function keyFor(email: string): Promise<{ key: string; key_id: string; plan: string; email: string }> {
  const res = await call("POST", "/v1/keys", { body: { email } });
  expect(res.status).toBe(202);
  const ok = await confirm(await lastToken(email));
  expect(ok.status).toBe(200);
  return (await ok.json()) as { key: string; key_id: string; plan: string; email: string };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(SEEDS)) await setSetting(k, v);
});

describe("TCS-64 settings rows", () => {
  it("settings rows: the 7 rows exist with the seed values", async () => {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN (${Object.keys(SEEDS).map(() => "?").join(",")})`,
    )
      .bind(...Object.keys(SEEDS))
      .all<{ key: string; value: string }>();
    expect(Object.fromEntries(results.map((r) => [r.key, r.value]))).toEqual(SEEDS);
  });
});

describe("POST /v1/keys sends a link", () => {
  it("POST: answers 202 with a fixed body, no key, no row, and exactly one mail with the confirm link", async () => {
    const email = uniqueEmail("first");
    const res = await call("POST", "/v1/keys", { body: { email } });
    expect(res.status).toBe(202);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("sent");
    expect(body.expires_in_seconds).toBe(3600);
    expect(body.key).toBeUndefined();
    expect(await rowsFor(email)).toHaveLength(0);

    const mails = await outbox(email);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(email);
    expect(mails[0].from).toBe("keys@tocsin.sh");
    expect(mails[0].subject).toBe("Your Tocsin API key link");
    expect(mails[0].text).toContain("https://tocsin.sh/v1/keys/confirm?token=tct_");
    expect(mails[0].text).toContain("to get your Tocsin API key");
    expect(mails[0].text).toContain("open the link and press Confirm");
  });

  it("POST: a registered email (also upper case with spaces) gets a byte-identical 202, a second mail with the replace text, no 409", async () => {
    const email = uniqueEmail("again");
    await keyFor(email);
    const fresh = await call("POST", "/v1/keys", { body: { email: uniqueEmail("never-seen") } });
    expect(fresh.status).toBe(202);
    const freshBody = await fresh.text();

    for (const variant of [email, `  ${email.toUpperCase()}  `]) {
      const res = await call("POST", "/v1/keys", { body: { email: variant } });
      expect(res.status).toBe(202);
      expect(await res.text()).toBe(freshBody);
      expect(res.headers.get("Cache-Control")).toBe(fresh.headers.get("Cache-Control"));
      expect(res.headers.get("Content-Type")).toBe(fresh.headers.get("Content-Type"));
    }
    const mails = await outbox(email);
    expect(mails).toHaveLength(3);
    expect(mails[2].text).toContain("replace the API key for this email");
    expect(mails[2].text).toMatch(LINK_RE);
    expect(await rowsFor(email)).toHaveLength(1);
  });

  it("POST: answers 400 for a bad body on both send routes", async () => {
    for (const path of ["/v1/keys", "/v1/keys/rotate"]) {
      for (const body of [{}, { email: "a@b" }]) {
        expect((await call("POST", path, { body })).status, `${path} ${JSON.stringify(body)}`).toBe(400);
      }
      expect((await call("POST", path, { rawBody: "{not json" })).status).toBe(400);
    }
  });

  it("POST: per-email limit from settings: [202, 202, 429] across 3 IPs, same 429 for a registered and a new email", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2031, 0, 2, 3, 10, 0));
    const registered = uniqueEmail("em-reg");
    await keyFor(registered); // 1 send for this email this hour
    await setSetting("keys.email_sends_per_hour", "2");

    const fresh = uniqueEmail("em-new");
    const statuses: number[] = [];
    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await call("POST", "/v1/keys", { ip: nextIp(), body: { email: fresh } });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.headers.get("Retry-After")).toBe(String(50 * 60));
        bodies.push(await res.text());
      }
    }
    expect(statuses).toEqual([202, 202, 429]);

    expect((await call("POST", "/v1/keys", { ip: nextIp(), body: { email: registered } })).status).toBe(202);
    const reg429 = await call("POST", "/v1/keys", { ip: nextIp(), body: { email: registered } });
    expect(reg429.status).toBe(429);
    expect(await reg429.text()).toBe(bodies[0]);
    expect(await outbox(fresh)).toHaveLength(2);
  });

  it("POST: per-IP hour limit from settings: [202, 202, 429] for 3 emails from one IP", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2031, 0, 3, 4, 0, 5));
    await setSetting("keys.ip_sends_per_hour", "2");
    const ip = nextIp();
    const statuses: number[] = [];
    // Spread over three minutes so the per-minute limiter (5) is not what answers.
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.UTC(2031, 0, 3, 4, i, 5));
      statuses.push((await call("POST", "/v1/keys", { ip, body: { email: uniqueEmail("ip") } })).status);
    }
    expect(statuses).toEqual([202, 202, 429]);
  });

  it("POST: daily cap from settings: 503, no mail, and one daily_send_cap_hit alert line", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2031, 0, 4, 12, 0, 0));
    await setSetting("mail.daily_send_cap", "1");
    expect((await call("POST", "/v1/keys", { body: { email: uniqueEmail("cap-1") } })).status).toBe(202);

    const err = vi.spyOn(console, "error");
    const email = uniqueEmail("cap-2");
    const res = await call("POST", "/v1/keys", { body: { email } });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe(String(12 * 3600));
    expect(await outbox(email)).toHaveLength(0);
    const alerts = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"alert":"daily_send_cap_hit"'));
    expect(alerts).toHaveLength(1);
  });

  it("POST: an unknown mail.provider answers 503, writes no token, sends nothing, logs mail_not_configured", async () => {
    await setSetting("mail.provider", "nope");
    const err = vi.spyOn(console, "error");
    const before = await tokenCount();
    const email = uniqueEmail("noprov");
    const res = await call("POST", "/v1/keys", { body: { email } });
    expect(res.status).toBe(503);
    expect(await tokenCount()).toBe(before);
    expect(await outbox(email)).toHaveLength(0);
    expect(err.mock.calls.some((c) => String(c[0]).includes('"alert":"mail_not_configured"'))).toBe(true);
  });

  it("POST: a failed send answers 502, deletes its token and leaves the counters unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2031, 0, 5, 6, 0, 0));
    await setSetting("keys.email_sends_per_hour", "1");
    await setSetting("mail.from_address", "fail@fake.test");
    const email = uniqueEmail("fail");
    const before = await tokenCount();
    const res = await call("POST", "/v1/keys", { body: { email } });
    expect(res.status).toBe(502);
    expect(await tokenCount()).toBe(before);

    await setSetting("mail.from_address", "keys@tocsin.sh");
    expect((await call("POST", "/v1/keys", { body: { email } })).status).toBe(202);
    expect(await outbox(email)).toHaveLength(1);
  });
});

describe("GET /v1/keys/confirm writes nothing", () => {
  it("GET: a live create link shows the Confirm page with a same-origin POST form, and makes no row and spends no token", async () => {
    const email = uniqueEmail("get-create");
    expect((await call("POST", "/v1/keys", { body: { email } })).status).toBe(202);
    const token = await lastToken(email);
    for (let i = 0; i < 3; i++) {
      const page = await openLink(token);
      expect(page.status).toBe(200);
      expect(page.headers.get("Content-Type")).toContain("text/html");
      expect(page.headers.get("Cache-Control")).toBe("no-store");
      expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
      const html = await page.text();
      expect(html).toContain("Confirm your Tocsin key");
      expect(html).toContain('<form method="post" action="/v1/keys/confirm">');
      expect(html).toContain(`<input type="hidden" name="token" value="${token}">`);
      expect(html).not.toContain("tcs_");
      expect(html).not.toContain(email);
    }
    expect(await rowsFor(email)).toHaveLength(0);
    expect(await hasToken(token)).toBe(true);
    expect((await confirm(token)).status).toBe(200);
    expect(await rowsFor(email)).toHaveLength(1);
  });

  it("GET: a live replace link changes no row; the old key still works after the GET, and only the POST rotates it", async () => {
    const email = uniqueEmail("get-rotate");
    const k1 = await keyFor(email);
    const before = await rowsFor(email);
    expect((await call("POST", "/v1/keys/rotate", { body: { email } })).status).toBe(202);
    const token = await lastToken(email);
    const page = await openLink(token);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Confirm your Tocsin key");
    expect(await rowsFor(email)).toEqual(before);
    expect(await hasToken(token)).toBe(true);
    expect((await call("GET", "/v1/watchlists", { key: k1.key })).status).toBe(200);

    const ok = await confirm(token);
    expect(ok.status).toBe(200);
    expect((await call("GET", "/v1/watchlists", { key: k1.key })).status).toBe(401);
  });

  it("GET: a spent, unknown, expired, malformed or missing token shows one neutral 410 page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2031, 0, 7, 9, 0, 0);
    vi.setSystemTime(t0);
    const spentEmail = uniqueEmail("get-spent");
    expect((await call("POST", "/v1/keys", { body: { email: spentEmail } })).status).toBe(202);
    const spent = await lastToken(spentEmail);
    expect((await confirm(spent)).status).toBe(200);
    const lateEmail = uniqueEmail("get-late");
    expect((await call("POST", "/v1/keys", { body: { email: lateEmail } })).status).toBe(202);
    const late = await lastToken(lateEmail);
    vi.setSystemTime(t0 + 3601_000);

    const bodies: string[] = [];
    for (const path of [`?token=${spent}`, `?token=${late}`, `?token=tct_${"0".repeat(64)}`, "?token=abc", ""]) {
      const res = await call("GET", `/v1/keys/confirm${path}`);
      expect(res.status, path).toBe(410);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("This link is used or expired");
    expect(bodies[0]).not.toContain("<form");
    expect(await hasToken(late)).toBe(true); // the GET did not even delete the expired token
    expect(await rowsFor(lateEmail)).toHaveLength(0);
  });
});

describe("POST /v1/keys/confirm (the Confirm button)", () => {
  it("POST form: the button answers an HTML page with the key once; a second press is 410", async () => {
    const email = uniqueEmail("form");
    expect((await call("POST", "/v1/keys", { body: { email } })).status).toBe(202);
    const token = await lastToken(email);
    const res = await confirmForm(token, { Origin: "https://tocsin.test" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    const key = /tcs_[0-9a-f]{64}/.exec(html)?.[0];
    expect(key).toBeDefined();
    expect((await rowsFor(email))[0].key_hash).toBe(await sha256HexOf(key!));
    const again = await confirmForm(token, { Origin: "https://tocsin.test" });
    expect(again.status).toBe(410);
    expect(await again.text()).not.toMatch(/tcs_[0-9a-f]{64}/);
  });

  it("POST: a cross-origin form is 403 and spends no token", async () => {
    const email = uniqueEmail("xorigin");
    expect((await call("POST", "/v1/keys", { body: { email } })).status).toBe(202);
    const token = await lastToken(email);
    expect((await confirmForm(token, { Origin: "https://evil.test" })).status).toBe(403);
    expect(await hasToken(token)).toBe(true);
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it("POST: the per-IP limiter (keys.anon_rate_per_minute) answers 429 on the 6th POST in a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2031, 0, 8, 10, 0, 5));
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await confirm(`tct_${"1".repeat(64)}`, ip)).status);
    expect(statuses).toEqual([410, 410, 410, 410, 410, 429]);
  });
});

describe("POST /v1/keys/confirm (JSON)", () => {
  it("confirm: answers the key once, stores only its sha256; the same link again is 410", async () => {
    const email = uniqueEmail("confirm");
    expect((await call("POST", "/v1/keys", { body: { email } })).status).toBe(202);
    const token = await lastToken(email);
    const res = await confirm(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { key: string; key_id: string; plan: string; email: string };
    expect(body.key).toMatch(/^tcs_[0-9a-f]{64}$/);
    expect(body.plan).toBe("free");
    expect(body.email).toBe(email);

    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(body.key_id);
    expect(rows[0].key_hash).toBe(await sha256HexOf(body.key));
    for (const v of Object.values(rows[0])) expect(v).not.toBe(body.key);

    const again = await confirm(token);
    expect(again.status).toBe(410);
    expect(((await again.json()) as Record<string, unknown>).key).toBeUndefined();
  });

  it("confirm: an expired token is 410 with no row; a token inside the hour works", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2031, 0, 6, 8, 0, 0);
    vi.setSystemTime(t0);
    const late = uniqueEmail("late");
    expect((await call("POST", "/v1/keys", { body: { email: late } })).status).toBe(202);
    const lateToken = await lastToken(late);
    vi.setSystemTime(t0 + 3601_000);
    expect((await confirm(lateToken)).status).toBe(410);
    expect(await rowsFor(late)).toHaveLength(0);

    vi.setSystemTime(t0 + 10_000);
    const ontime = uniqueEmail("ontime");
    expect((await call("POST", "/v1/keys", { body: { email: ontime } })).status).toBe(202);
    const token = await lastToken(ontime);
    vi.setSystemTime(t0 + 10_000 + 3599_000);
    expect((await confirm(token)).status).toBe(200);
    expect(await rowsFor(ontime)).toHaveLength(1);
  });

  it("confirm: two links sent before either is opened give one key and one 410", async () => {
    const email = uniqueEmail("race");
    expect((await call("POST", "/v1/keys", { body: { email } })).status).toBe(202);
    expect((await call("POST", "/v1/keys", { body: { email } })).status).toBe(202);
    const mails = await outbox(email);
    expect(mails).toHaveLength(2);
    const tokens = mails.map((m) => LINK_RE.exec(m.text)![1]);
    expect(tokens[0]).not.toBe(tokens[1]);
    const statuses = (await Promise.all(tokens.map((t) => confirm(t)))).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 410]);
    expect(await rowsFor(email)).toHaveLength(1);
  });

  it("confirm: answers 400 with no token or a malformed token, 410 for an unknown one", async () => {
    expect((await call("POST", "/v1/keys/confirm", { body: {} })).status).toBe(400);
    expect((await call("POST", "/v1/keys/confirm", { rawBody: "{not json" })).status).toBe(400);
    expect((await confirm("abc")).status).toBe(400);
    expect((await confirm(`tct_${"0".repeat(64)}`)).status).toBe(410);
  });
});

describe("POST /v1/keys/rotate", () => {
  it("rotate: the link replaces the key in place; old key 401, new key 200, watch lists kept", async () => {
    const email = uniqueEmail("rotate");
    const k1 = await keyFor(email);
    const created = await call("POST", "/v1/watchlists", { key: k1.key, body: { name: "kept" } });
    expect(created.status).toBe(201);

    const fresh = await call("POST", "/v1/keys/rotate", { body: { email: uniqueEmail("rotate-new") } });
    const res = await call("POST", "/v1/keys/rotate", { body: { email } });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe(await fresh.text());
    const mails = await outbox(email);
    expect(mails).toHaveLength(2);
    expect(mails[1].text).toContain("The old key stops working when you press Confirm");

    const ok = await confirm(await lastToken(email));
    expect(ok.status).toBe(200);
    const k2 = (await ok.json()) as { key: string; key_id: string; plan: string };
    expect(k2.key).not.toBe(k1.key);
    expect(k2.key_id).toBe(k1.key_id);
    expect(k2.plan).toBe(k1.plan);

    expect((await call("GET", "/v1/watchlists", { key: k1.key })).status).toBe(401);
    const lists = await call("GET", "/v1/watchlists", { key: k2.key });
    expect(lists.status).toBe(200);
    const names = ((await lists.json()) as { watchlists: { name: string }[] }).watchlists.map((w) => w.name);
    expect(names).toEqual(["kept"]);
    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(await sha256HexOf(k2.key));
  });

  it("rotate: two replace links sent before either is opened give one new key and one 410", async () => {
    const email = uniqueEmail("rotate-race");
    const k1 = await keyFor(email);
    expect((await call("POST", "/v1/keys/rotate", { body: { email } })).status).toBe(202);
    expect((await call("POST", "/v1/keys/rotate", { body: { email } })).status).toBe(202);
    const tokens = (await outbox(email)).slice(1).map((m) => LINK_RE.exec(m.text)![1]);
    expect(tokens).toHaveLength(2);

    const answers = await Promise.all(tokens.map((t) => confirm(t)));
    expect(answers.map((r) => r.status).sort()).toEqual([200, 410]);
    const k2 = (await answers.find((r) => r.status === 200)!.json()) as { key: string; key_id: string };
    expect(k2.key_id).toBe(k1.key_id);
    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(await sha256HexOf(k2.key));
    expect((await call("GET", "/v1/watchlists", { key: k2.key })).status).toBe(200);
  });
});
