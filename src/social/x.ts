// The one X adapter (BH-7563 seam). Only this file builds an api.x.com URL and
// calls fetch for X. POST /2/tweets and DELETE /2/tweets/:id with OAuth 1.0a
// user context of the @tocsinagent account. The answer is classified by the
// caller (src/social/classify.ts); this file never logs a header or a token.
import type { Env } from "../env";
import { FakeX } from "./fake";
import { oauth1Header, type OAuth1Credentials } from "./oauth1";

export type XCredentials = OAuth1Credentials;

export type XPostOutcome =
  | { kind: "ok"; id: string }
  | { kind: "empty"; status: number }
  | { kind: "http"; status: number; body: string }
  | { kind: "network"; error: string };

export type XDeleteOutcome = { kind: "ok"; deleted: boolean } | { kind: "http"; status: number; body: string } | { kind: "network"; error: string };

export interface XClient {
  post(text: string): Promise<XPostOutcome>;
  remove(id: string): Promise<XDeleteOutcome>;
}

export type XClientFactory = (env: Env, timeoutMs: number) => XClient | null;

const API = "https://api.x.com/2/tweets";

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

export class RealX implements XClient {
  constructor(
    private readonly creds: XCredentials,
    private readonly timeoutMs: number,
  ) {}

  async post(text: string): Promise<XPostOutcome> {
    let res: Response;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { Authorization: await oauth1Header("POST", API, this.creds), "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // The name only (TimeoutError, TypeError): the post may or may not have gone out.
      return { kind: "network", error: errName(err) };
    }
    const body = await res.text().catch(() => "");
    if (!res.ok) return { kind: "http", status: res.status, body };
    let id: unknown;
    try {
      id = (JSON.parse(body) as { data?: { id?: unknown } }).data?.id;
    } catch {
      id = undefined;
    }
    return typeof id === "string" && id !== "" ? { kind: "ok", id } : { kind: "empty", status: res.status };
  }

  async remove(id: string): Promise<XDeleteOutcome> {
    const url = `${API}/${encodeURIComponent(id)}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "DELETE", headers: { Authorization: await oauth1Header("DELETE", url, this.creds) }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      return { kind: "network", error: errName(err) };
    }
    const body = await res.text().catch(() => "");
    if (!res.ok) return { kind: "http", status: res.status, body };
    let deleted = false;
    try {
      deleted = (JSON.parse(body) as { data?: { deleted?: unknown } }).data?.deleted === true;
    } catch {
      deleted = false;
    }
    return { kind: "ok", deleted };
  }
}

/**
 * The X client: the KV fake when SOCIAL_TRANSPORT is "fake" (vitest.config.ts
 * only), the real adapter when all four secrets are set, else null (the lane
 * records not_configured and makes no call).
 */
export function getXClient(env: Env, timeoutMs: number): XClient | null {
  if (env.SOCIAL_TRANSPORT === "fake") return new FakeX(env.CURSORS);
  const consumerKey = (env.X_CONSUMER_KEY ?? "").trim();
  const consumerSecret = (env.X_CONSUMER_SECRET ?? "").trim();
  const token = (env.X_ACCESS_TOKEN ?? "").trim();
  const tokenSecret = (env.X_ACCESS_TOKEN_SECRET ?? "").trim();
  if (!consumerKey || !consumerSecret || !token || !tokenSecret) return null;
  return new RealX({ consumerKey, consumerSecret, token, tokenSecret }, timeoutMs);
}
