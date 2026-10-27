import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { get } from "../routes/seed.tcs-3";
import { setKnob, uid } from "./helpers.tcs-106";

// TCS-106: GET /v1/status gains a social block (enabled, posted_24h, last_error),
// through the production entry (src/index.ts -> app).

const ip = "198.51.100.106";
const HOUR = 3_600_000;

interface Social {
  enabled: boolean;
  posted_24h: number;
  last_error: string | null;
}

async function social(): Promise<Social> {
  const res = await get("/v1/status", ip);
  expect(res.status).toBe(200);
  return ((await res.json()) as { social: Social }).social;
}

async function okRow(at: Date): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO social_posts (advisory_id, channel, status, attempts, next_at, first_attempt_at, posted_id, posted_at, text, created_at, updated_at) VALUES (?1, 'x', 'ok', 1, ?2, ?2, 'fake-s', ?2, 't', ?2, ?2)",
  )
    .bind(`tcs_${uid("st")}`, at.toISOString())
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM social_posts").run();
  await env.DB.prepare("UPDATE sources SET last_error = NULL WHERE id = 'social-x'").run();
});

describe("GET /v1/status social block", () => {
  it("ST1: enabled is false by default (the migration seed), posted_24h 0, last_error null", async () => {
    expect(await social()).toEqual({ enabled: false, posted_24h: 0, last_error: null });
  });

  it("ST2: two ok posts in the last 24 h and one older count 2; enabled follows the row", async () => {
    await okRow(new Date(Date.now() - 2 * HOUR));
    await okRow(new Date(Date.now() - 20 * HOUR));
    await okRow(new Date(Date.now() - 30 * HOUR));
    await setKnob("social.x.enabled", "1");
    const s = await social();
    await setKnob("social.x.enabled", "0");
    expect(s.posted_24h).toBe(2);
    expect(s.enabled).toBe(true);
  });

  it("ST3: last_error reads the social-x sources row", async () => {
    await env.DB.prepare("UPDATE sources SET last_error = 'not_configured' WHERE id = 'social-x'").run();
    expect((await social()).last_error).toBe("not_configured");
  });
});
