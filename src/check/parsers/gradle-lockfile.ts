import { LockfileParseError, ResultBuilder, type ParseResult } from "./types";

/**
 * gradle.lockfile: one `group:artifact:version=configurations` line per
 * dependency; `#` comments and the `empty=` line are ignored. A file with no
 * lock line and no `empty=` line is not a Gradle lockfile.
 */
export function parseGradleLockfile(text: string): ParseResult {
  const out = new ResultBuilder();
  let recognized = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (line.startsWith("empty=")) {
      recognized = true;
      return;
    }
    const m = /^([^:\s=]+):([^:\s=]+):([^:\s=]+)=\S*$/.exec(line);
    if (!m) {
      out.skip(line, "not a lock line", i + 1);
      return;
    }
    recognized = true;
    out.add("Maven", `${m[1]}:${m[2]}`, m[3]);
  });
  if (!recognized) throw new LockfileParseError("gradle-lockfile", "no group:artifact:version line");
  return out.build();
}
