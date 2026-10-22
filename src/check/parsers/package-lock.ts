import { LockfileParseError, ResultBuilder, type ParseResult } from "./types";

interface Entry {
  name?: unknown;
  version?: unknown;
  link?: unknown;
}

/** npm package-lock.json / npm-shrinkwrap.json, lockfileVersion 2 or 3 (the `packages` map). */
export function parsePackageLock(text: string): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new LockfileParseError("package-lock", "invalid JSON");
  }
  const packages = (doc as { packages?: unknown } | null)?.packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    throw new LockfileParseError("package-lock", "no `packages` map (lockfileVersion 2 or 3 required)");
  }
  const out = new ResultBuilder();
  for (const [key, value] of Object.entries(packages as Record<string, Entry>)) {
    if (key === "") continue;
    const entry = value ?? {};
    if (entry.link === true) {
      out.skip(key, "linked local package");
      continue;
    }
    const at = key.lastIndexOf("node_modules/");
    if (at === -1) {
      out.skip(key, "local workspace package");
      continue;
    }
    const name = typeof entry.name === "string" ? entry.name : key.slice(at + "node_modules/".length);
    if (typeof entry.version !== "string" || entry.version === "") {
      out.skip(key, "no version");
      continue;
    }
    out.add("npm", name, entry.version);
  }
  return out.build();
}
