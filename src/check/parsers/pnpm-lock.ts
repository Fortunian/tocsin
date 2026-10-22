import { ResultBuilder, type ParseResult } from "./types";

/**
 * pnpm-lock.yaml: the keys of the top-level `packages:` map.
 * Key forms: `/name/1.2.3` (v5), `/name@1.2.3` (v6), `name@1.2.3` (v9), each with an optional peer suffix.
 */
export function parsePnpmLock(text: string): ParseResult {
  const out = new ResultBuilder();
  const lines = text.split(/\r?\n/);
  let inPackages = false;
  lines.forEach((line, i) => {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      return;
    }
    if (!inPackages) return;
    const m = /^ {2}(\S.*?):\s*(\{\})?\s*$/.exec(line);
    if (!m) return;
    const raw = m[1];
    const parsed = splitKey(raw);
    if (!parsed) out.skip(raw, "unrecognized package key", i + 1);
    else if (parsed.version.includes(":")) out.skip(raw, "not from a registry", i + 1);
    else out.add("npm", parsed.name, parsed.version);
  });
  return out.build();
}

function splitKey(raw: string): { name: string; version: string } | null {
  let key = raw.replace(/^['"]|['"]$/g, "").replace(/\(.*$/, "");
  const leadingSlash = key.startsWith("/");
  if (leadingSlash) key = key.slice(1);
  const parts = key.split("/");
  const nameParts = key.startsWith("@") ? 2 : 1;
  if (leadingSlash && parts.length > nameParts && !parts[nameParts - 1].slice(1).includes("@")) {
    // v5: name/version_peers or @scope/name/version_peers
    const version = parts[nameParts].replace(/_.*$/, "");
    return version ? { name: parts.slice(0, nameParts).join("/"), version } : null;
  }
  const at = key.lastIndexOf("@");
  if (at <= 0) return null;
  const version = key.slice(at + 1);
  return version ? { name: key.slice(0, at), version } : null;
}
