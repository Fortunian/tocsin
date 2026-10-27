import { classifyXAnswer, type XClient, type XDeleteResult, type XPostResult } from "./x";

// Test fake of the X seam: 0 network calls. Each post is appended to a KV
// outbox, so a test reads it whatever isolate served the request. The answer
// follows the KV key social:fake:mode, so a test drives every branch:
// ok (default), empty, 429, 500, 402, 403, network. social:fake:body, when set,
// is the body of an error answer. An HTTP mode goes through classifyXAnswer,
// the same rule as the real adapter. remove() is not implemented: the PR suite
// never deletes.
export const FAKE_X_CALLS_KEY = "social:fake:calls";
export const FAKE_X_MODE_KEY = "social:fake:mode";
export const FAKE_X_BODY_KEY = "social:fake:body";
const OUTBOX_TTL_SECONDS = 3600; // KV minimum is 60; a test outbox needs no more than an hour.

export type FakeXMode = "ok" | "empty" | "429" | "500" | "402" | "403" | "network";

export interface FakeXCall {
  text: string;
}

export class FakeX implements XClient {
  constructor(private readonly kv: KVNamespace) {}

  async post(text: string): Promise<XPostResult> {
    const calls = await readFakeXCalls(this.kv);
    calls.push({ text });
    await this.kv.put(FAKE_X_CALLS_KEY, JSON.stringify(calls), { expirationTtl: OUTBOX_TTL_SECONDS });
    const mode = ((await this.kv.get(FAKE_X_MODE_KEY)) ?? "ok") as FakeXMode;
    if (mode === "network") return { kind: "network", status: 0, error: "network: TypeError" };
    if (mode === "ok") return classifyXAnswer(201, JSON.stringify({ data: { id: `fake-${calls.length}`, text } }));
    if (mode === "empty") return classifyXAnswer(200, "{}");
    return classifyXAnswer(Number(mode), (await this.kv.get(FAKE_X_BODY_KEY)) ?? `fake ${mode}`);
  }

  async remove(_id: string): Promise<XDeleteResult> {
    throw new Error("FakeX.remove is unimplemented");
  }
}

export async function readFakeXCalls(kv: KVNamespace): Promise<FakeXCall[]> {
  const raw = await kv.get(FAKE_X_CALLS_KEY);
  return raw === null ? [] : (JSON.parse(raw) as FakeXCall[]);
}
