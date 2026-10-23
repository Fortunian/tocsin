import { LockfileParseError, ResultBuilder, type ParseResult } from "./types";

/** packages.lock.json: `dependencies.<framework>.<name>.resolved` of every framework. Project references are skipped. */
export function parseNugetLock(text: string): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new LockfileParseError("nuget-lock", "invalid JSON");
  }
  const deps = (doc as { dependencies?: unknown } | null)?.dependencies;
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
    throw new LockfileParseError("nuget-lock", "no `dependencies` object");
  }
  const out = new ResultBuilder();
  for (const framework of Object.values(deps as Record<string, unknown>)) {
    if (typeof framework !== "object" || framework === null) continue;
    for (const [name, entry] of Object.entries(framework as Record<string, unknown>)) {
      const e = (entry ?? {}) as { type?: unknown; resolved?: unknown };
      if (e.type === "Project") out.skip(name, "project reference");
      else if (typeof e.resolved === "string" && e.resolved !== "") out.add("NuGet", name, e.resolved);
      else out.skip(name, "entry without resolved version");
    }
  }
  return out.build();
}
