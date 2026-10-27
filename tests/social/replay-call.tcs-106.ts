import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../../src/index";

// POST /v1/internal/social/replay through the production worker (src/index.ts).
// Each call passes its own env, so a test sets or unsets IMPORT_TOKEN.
export const REPLAY_TOKEN = "tok-fixture-replay-106";

export async function replay(body: unknown, opts: { token?: string | null; envToken?: string | null } = {}): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.token !== null) headers.set("Authorization", `Bearer ${opts.token ?? REPLAY_TOKEN}`);
  const e = { ...env } as typeof env & { IMPORT_TOKEN?: string };
  if (opts.envToken === null) delete e.IMPORT_TOKEN;
  else e.IMPORT_TOKEN = opts.envToken ?? REPLAY_TOKEN;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://tocsin.test/v1/internal/social/replay", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
