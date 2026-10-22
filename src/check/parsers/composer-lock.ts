import { LockfileParseError, ResultBuilder, type ParseResult } from "./types";

/** composer.lock: entries of `packages` and `packages-dev`. */
export function parseComposerLock(text: string): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new LockfileParseError("composer-lock", "invalid JSON");
  }
  const d = (doc ?? {}) as { packages?: unknown; "packages-dev"?: unknown };
  const lists = [d.packages, d["packages-dev"]].filter((x) => x !== undefined && x !== null);
  if (lists.length === 0 || lists.some((x) => !Array.isArray(x))) {
    throw new LockfileParseError("composer-lock", "no `packages` or `packages-dev` array");
  }
  const out = new ResultBuilder();
  for (const list of lists as unknown[][]) {
    for (const entry of list) {
      const e = (entry ?? {}) as { name?: unknown; version?: unknown };
      if (typeof e.name === "string" && typeof e.version === "string" && e.name && e.version) {
        out.add("Packagist", e.name, e.version);
      } else {
        out.skip(JSON.stringify(entry).slice(0, 200), "entry without name or version");
      }
    }
  }
  return out.build();
}
