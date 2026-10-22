import { ResultBuilder, type ParseResult } from "./types";

/**
 * Gemfile.lock: the 4-space `name (version)` lines under `specs:` in each `GEM` section.
 * 6-space lines are dependency constraints and are not read. Specs in `GIT` and `PATH` sections are skipped.
 */
export function parseGemfileLock(text: string): ParseResult {
  const out = new ResultBuilder();
  let section = "";
  let inSpecs = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\S/.test(line)) {
      section = line.trim();
      inSpecs = false;
      return;
    }
    if (/^ {2}specs:\s*$/.test(line)) {
      inSpecs = true;
      return;
    }
    if (/^ {2}\S/.test(line)) {
      inSpecs = false;
      return;
    }
    if (!inSpecs) return;
    const m = /^ {4}(\S+) \(([^)]+)\)\s*$/.exec(line);
    if (!m) return;
    if (section === "GEM") out.add("RubyGems", m[1], m[2]);
    else out.skip(line.trim(), `${section} source, not from a registry`, i + 1);
  });
  return out.build();
}
