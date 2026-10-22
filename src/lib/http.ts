import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const JSON_UTF8 = "application/json; charset=utf-8";

// Every JSON answer goes through here so the charset is explicit, not Hono's default.
export function jsonUtf8(
  c: Context,
  body: unknown,
  status: ContentfulStatusCode = 200,
  headers: Record<string, string> = {},
): Response {
  return c.body(JSON.stringify(body), status, { ...headers, "Content-Type": JSON_UTF8 });
}
