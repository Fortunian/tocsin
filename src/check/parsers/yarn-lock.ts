import { ResultBuilder, type ParseResult } from "./types";

const LOCAL_PROTOCOLS = ["workspace:", "link:", "portal:", "file:"];

/** yarn.lock, v1 text format or berry (yarn 2+) YAML. Berry is recognized by its `__metadata:` block. */
export function parseYarnLock(text: string): ParseResult {
  const berry = /^__metadata:\s*$/m.test(text);
  const versionLine = berry ? /^ {2}version: ["']?([^"'\s]+)["']?\s*$/ : /^ {2}version "?([^"\s]+)"?\s*$/;
  const out = new ResultBuilder();
  let current: string | null = null;
  text.split(/\r?\n/).forEach((line, i) => {
    if (line === "" || line.startsWith("#")) return;
    if (!/^\s/.test(line)) {
      current = null;
      if (!line.endsWith(":") || line.startsWith("__metadata")) return;
      const first = line.slice(0, -1).split(",")[0].trim().replace(/^"|"$/g, "");
      const at = first.indexOf("@", 1);
      if (at === -1) {
        out.skip(first, "unrecognized descriptor", i + 1);
        return;
      }
      const range = first.slice(at + 1);
      if (LOCAL_PROTOCOLS.some((p) => range.startsWith(p))) {
        out.skip(first, "local package, not from a registry", i + 1);
        return;
      }
      current = first.slice(0, at);
      return;
    }
    if (current === null) return;
    const m = versionLine.exec(line);
    if (m) {
      out.add("npm", current, m[1]);
      current = null;
    }
  });
  return out.build();
}
