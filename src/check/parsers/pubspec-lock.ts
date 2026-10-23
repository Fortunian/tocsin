import { LockfileParseError, ResultBuilder, type ParseResult } from "./types";

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

/**
 * pubspec.lock: the `packages:` map. A `source: hosted` package is read with
 * its `version` (the name from `description.name`, else the key). `sdk`, `git`
 * and `path` packages are skipped. An indentation reader; no YAML library.
 */
export function parsePubspecLock(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (start === -1) throw new LockfileParseError("pubspec-lock", "no `packages:` map");
  const out = new ResultBuilder();
  let pkg: { key: string; line: number; name?: string; source?: string; version?: string } | undefined;
  const flush = () => {
    if (!pkg) return;
    if (pkg.source !== "hosted") out.skip(pkg.key, "not hosted", pkg.line);
    else if (pkg.version) out.add("Pub", pkg.name ?? pkg.key, pkg.version);
    else out.skip(pkg.key, "hosted package without version", pkg.line);
    pkg = undefined;
  };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (/^\S/.test(line)) break; // the next top-level key (sdks:)
    const key = /^ {2}([^\s:]+):\s*$/.exec(line);
    if (key) {
      flush();
      pkg = { key: unquote(key[1]), line: i + 1 };
      continue;
    }
    if (!pkg) continue;
    const field = /^ {4}(source|version):\s*(.+)$/.exec(line);
    if (field) pkg[field[1] as "source" | "version"] = unquote(field[2]);
    const name = /^ {6}name:\s*(.+)$/.exec(line);
    if (name) pkg.name = unquote(name[1]);
  }
  flush();
  return out.build();
}
