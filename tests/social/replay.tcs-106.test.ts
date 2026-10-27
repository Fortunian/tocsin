import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callsFor, postsFor, resetSocial, seedAdvisory, setKnob, uid } from "./helpers.tcs-106";
import { replay } from "./replay-call.tcs-106";

// TCS-106 replay: POST /v1/internal/social/replay, bearer IMPORT_TOKEN. It
// writes nothing for an ok row and respects the enable flag and the daily cap.

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetSocial();
});
afterEach(() => vi.restoreAllMocks());

async function insertRow(advisoryId: string, status: string): Promise<void> {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO social_posts (advisory_id, channel, status, attempts, next_at, first_attempt_at, posted_id, posted_at, error, text, created_at, updated_at) VALUES (?1, 'x', ?2, 3, ?3, ?3, ?4, ?5, ?6, 'old text', ?3, ?3)",
  )
    .bind(advisoryId, status, at, status === "ok" ? "fake-old" : null, status === "ok" ? at : null, status === "failed" ? "x answered 503: busy" : null)
    .run();
}

describe("POST /v1/internal/social/replay", () => {
  it("R1: no bearer is 401; a wrong token is 403; IMPORT_TOKEN unset is 403", async () => {
    const a = await seedAdvisory();
    expect((await replay({ advisory_id: a.id }, { token: null })).status).toBe(401);
    expect((await replay({ advisory_id: a.id }, { token: "tok-fixture-wrong" })).status).toBe(403);
    expect((await replay({ advisory_id: a.id }, { envToken: null })).status).toBe(403);
    expect(await callsFor(a.id)).toHaveLength(0);
    expect(await postsFor(a.id)).toHaveLength(0);
  });

  it("R2: an ok row answers 200 changed:false, writes nothing and makes 0 calls", async () => {
    const a = await seedAdvisory();
    await insertRow(a.id, "ok");
    const [before] = await postsFor(a.id);
    const res = await replay({ advisory_id: a.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", changed: false });
    const [after] = await postsFor(a.id);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.text).toBe("old text");
    expect(await callsFor(a.id)).toHaveLength(0);
  });

  it("R3: a failed row is reset and posted once", async () => {
    const a = await seedAdvisory();
    await insertRow(a.id, "failed");
    const res = await replay({ advisory_id: a.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", changed: true });
    const [row] = await postsFor(a.id);
    expect(row).toMatchObject({ status: "ok", attempts: 1, error: null });
    expect(row.posted_id).toMatch(/^fake-/);
    expect(row.text).toContain(a.id);
    expect(await callsFor(a.id)).toHaveLength(1);
  });

  it("R4: social.x.enabled=0 answers 409 with 0 calls and no row", async () => {
    await setKnob("social.x.enabled", "0");
    const a = await seedAdvisory();
    expect((await replay({ advisory_id: a.id })).status).toBe(409);
    expect(await callsFor(a.id)).toHaveLength(0);
    expect(await postsFor(a.id)).toHaveLength(0);
  });

  it("R5: a full daily cap answers 429 with 0 calls and no row", async () => {
    await setKnob("social.x.daily_cap", "1");
    const used = `tcs_${uid("cap")}`;
    await env.DB.prepare(
      "INSERT INTO social_posts (advisory_id, channel, status, attempts, next_at, first_attempt_at, text, created_at, updated_at) VALUES (?1, 'x', 'ok', 1, ?2, ?2, 't', ?2, ?2)",
    )
      .bind(used, new Date().toISOString())
      .run();
    const a = await seedAdvisory();
    expect((await replay({ advisory_id: a.id })).status).toBe(429);
    expect(await callsFor(a.id)).toHaveLength(0);
    expect(await postsFor(a.id)).toHaveLength(0);
  });

  it("R6: an unknown advisory is 404; a malformed id is 400; a withdrawn one is 409", async () => {
    expect((await replay({ advisory_id: "tcs_01ZZZZZZZZZZZZZZZZZZZZZZZZ" })).status).toBe(404);
    expect((await replay({ advisory_id: "nope" })).status).toBe(400);
    expect((await replay("not json")).status).toBe(400);
    const a = await seedAdvisory();
    await env.DB.prepare("UPDATE advisories SET doc_json = json_set(doc_json, '$.withdrawn', '2026-10-27T00:00:00Z') WHERE id = ?").bind(a.id).run();
    expect((await replay({ advisory_id: a.id })).status).toBe(409);
    expect(await callsFor(a.id)).toHaveLength(0);
  });
});
