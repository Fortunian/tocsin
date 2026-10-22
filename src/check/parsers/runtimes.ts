import { ResultBuilder, type ParseResult } from "./types";

export const RUNTIMES = ["node", "php", "python", "go", "deno", "bun"] as const;
export type RuntimeName = (typeof RUNTIMES)[number];

/** Runtime versions sent by the caller. Each one becomes a dependency whose ecosystem and name are the runtime name. */
export function parseRuntimes(input: Partial<Record<RuntimeName, string>> & Record<string, unknown>): ParseResult {
  const out = new ResultBuilder();
  for (const rt of RUNTIMES) {
    const value = input[rt];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      out.skip(`${rt}=${JSON.stringify(value)}`, "empty or non-string version");
      continue;
    }
    out.add(rt, rt, value.trim());
  }
  for (const key of Object.keys(input)) {
    if (!(RUNTIMES as readonly string[]).includes(key)) out.skip(key, "unknown runtime");
  }
  return out.build();
}
