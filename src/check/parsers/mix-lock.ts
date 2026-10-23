import { LockfileParseError, ResultBuilder, type ParseResult } from "./types";

/**
 * mix.lock: an Elixir map of `"key": {:hex, :package, "version", ...}`. The
 * package atom is the Hex name (it can differ from the key). `:git` and other
 * sources are skipped.
 */
export function parseMixLock(text: string): ParseResult {
  if (!/^\s*%\{/.test(text)) throw new LockfileParseError("mix-lock", "not a mix.lock map (%{...})");
  const out = new ResultBuilder();
  text.split(/\r?\n/).forEach((line, i) => {
    const entry = /^\s*"([^"]+)":\s*\{:(\w+),\s*(.*)$/.exec(line);
    if (!entry) return;
    const [, key, source, rest] = entry;
    if (source !== "hex") {
      out.skip(key, "not from hex", i + 1);
      return;
    }
    const m = /^:"?([\w.-]+)"?,\s*"([^"]+)"/.exec(rest);
    if (m) out.add("Hex", m[1], m[2]);
    else out.skip(line.trim().slice(0, 200), "hex entry without name or version", i + 1);
  });
  return out.build();
}
