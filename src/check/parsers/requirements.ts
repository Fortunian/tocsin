import { ResultBuilder, type ParseResult } from "./types";

const PIN = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*==\s*([^\s,;*=<>!~]+)$/;

/** PEP 503 normalized name: lowercase, runs of `-`, `_`, `.` become one `-`. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * requirements.txt: only exact `name==version` pins are dependencies.
 * Any other line that names a package (a range, a wildcard, a bare name, a URL, `-e`) goes to `skipped`.
 * Comments, blank lines, option lines (`-r`, `-c`, `--index-url`, `--hash`) and continuations are consumed.
 */
export function parseRequirements(text: string): ParseResult {
  const out = new ResultBuilder();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let logical = lines[i];
    while (logical.endsWith("\\") && i + 1 < lines.length) {
      logical = logical.slice(0, -1) + " " + lines[++i];
    }
    const stmt = stripComment(logical).trim();
    if (stmt === "") continue;
    if (stmt.startsWith("-e ") || stmt.startsWith("--editable")) {
      out.skip(stmt, "editable install, not an exact pin", lineNo);
      continue;
    }
    if (stmt.startsWith("-")) continue;
    const spec = stmt.split(";")[0].replace(/\s--\S+(?:[ =]\S+)?/g, "").trim();
    const m = PIN.exec(spec);
    if (m) out.add("PyPI", normalizePypiName(m[1]), m[3]);
    else out.skip(stmt, "not an exact pin", lineNo);
  }
  return out.build();
}

function stripComment(line: string): string {
  if (line.trimStart().startsWith("#")) return "";
  const at = line.search(/\s#/);
  return at === -1 ? line : line.slice(0, at);
}
