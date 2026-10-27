// The one X adapter (BH-7563 seam). Only this file builds an api.x.com URL and
// calls fetch for X. POST /2/tweets and DELETE /2/tweets/:id with OAuth 1.0a
// user context of the @tocsinagent account. classifyXAnswer below is the one
// rule for every answer; this file never logs a header or a token.
import type { Env } from "../env";
import { FakeX } from "./fake";
import { oauth1Header, type OAuth1Credentials } from "./oauth1";

export type XCredentials = OAuth1Credentials;

// The class of one X answer (TCS-106). ok: 2xx with a post id. empty: 2xx
// without one (terminal). retryable: 429 or 5xx. billing: no credits on the
// account (402, or a 403 whose body names credits, billing, payment or
// enrollment; comment 6447345509): a vendor failure, no post was made.
// terminal: any other answer. network: no answer (status 0); the post may
// have gone out.
export type XKind = "ok" | "empty" | "retryable" | "billing" | "terminal" | "network";

export interface XPostResult {
  kind: XKind;
  status: number;
  id?: string;
  error?: string; // at most ERROR_MAX_CHARS, never a header or a token
}

export type XDeleteResult = { kind: "ok"; deleted: boolean } | { kind: "http"; status: number; body: string } | { kind: "network"; error: string };

export const ERROR_MAX_CHARS = 200; // the ticket's cap on stored error text (social_posts.error), not a tunable limit

// Plan ASSUMPTIONS 13: X's exact billing body is not known here; these words cover the shapes seen.
const BILLING_403 = /credit|billing|payment|enrol/i;

/** The one rule that maps an X HTTP answer to its class. Pure; the lane, the replay route and the contract suite share it. */
export function classifyXAnswer(status: number, body: string): XPostResult {
  if (status >= 200 && status < 300) {
    let id: unknown;
    try {
      id = (JSON.parse(body) as { data?: { id?: unknown } } | null)?.data?.id;
    } catch {
      id = undefined;
    }
    return typeof id === "string" && id !== "" ? { kind: "ok", status, id } : { kind: "empty", status, error: `x answered ${status} with no post id` };
  }
  const error = `x answered ${status}: ${body}`.slice(0, ERROR_MAX_CHARS);
  if (status === 402 || (status === 403 && BILLING_403.test(body))) return { kind: "billing", status, error };
  if (status === 429 || status >= 500) return { kind: "retryable", status, error };
  return { kind: "terminal", status, error };
}

export interface XClient {
  post(text: string): Promise<XPostResult>;
  remove(id: string): Promise<XDeleteResult>;
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

  async post(text: string): Promise<XPostResult> {
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
      // The name only (TimeoutError, TypeError): the post may or may not have gone out.
      return { kind: "network", status: 0, error: `network: ${errName(err)}` };
    }
    return classifyXAnswer(res.status, await res.text().catch(() => ""));
  }

  async remove(id: string): Promise<XDeleteResult> {
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
