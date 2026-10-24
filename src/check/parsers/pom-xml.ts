import { LockfileParseError, ResultBuilder, type ParseResult } from "./types";

// pom.xml is not a lockfile: it lists direct dependencies only. A version is
// read when it is a literal or a property defined in this same file
// (${project.version} and ${project.groupId} included). A version managed by a
// parent POM, an unknown property or a version range is skipped with its
// reason, never guessed. ${p} expansion is capped (MAX_RESOLVED_CHARS,
// MAX_EXPANSIONS). Regex parse (no XML library in the Worker bundle).

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml);
  return m ? m[1] : undefined;
};

// Removes every <name>...</name> block (non-nested tags only).
const strip = (xml: string, name: string) => xml.replace(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, "g"), "");

// Expansion caps (code constants: a parse runs per request and reads no DB row).
// A ${p} chain that doubles at each level grows as 2^n, so a 1 KB pom.xml could
// cost minutes of CPU. Past either cap the value is unresolved: the dependency
// is skipped, never read as clean.
export const MAX_RESOLVED_CHARS = 256;
export const MAX_EXPANSIONS = 200;
const UNRESOLVED = "unresolved_property";
const REF = /\$\{([^}]+)\}/g;

/**
 * Resolves ${name} references against one document's properties. A property is
 * resolved once and cached, and each resolution counts against MAX_EXPANSIONS.
 * A cycle, an unknown name, a value over MAX_RESOLVED_CHARS or a document past
 * MAX_EXPANSIONS gives undefined.
 */
function propertyResolver(props: Map<string, string>): (value: string) => string | undefined {
  const memo = new Map<string, string | undefined>();
  const active = new Set<string>();
  let expansions = 0;
  const lookup = (name: string): string | undefined => {
    if (memo.has(name)) return memo.get(name);
    const raw = props.get(name);
    if (raw === undefined || active.has(name) || ++expansions > MAX_EXPANSIONS) return undefined;
    active.add(name);
    const r = resolve(raw);
    active.delete(name);
    memo.set(name, r);
    return r;
  };
  const resolve = (value: string): string | undefined => {
    let out = "";
    let last = 0;
    for (const m of value.matchAll(REF)) {
      const v = lookup(m[1]);
      if (v === undefined) return undefined;
      out += value.slice(last, m.index) + v;
      last = m.index + m[0].length;
      if (out.length > MAX_RESOLVED_CHARS) return undefined;
    }
    out += value.slice(last);
    return out.length > MAX_RESOLVED_CHARS ? undefined : out;
  };
  return resolve;
}

export function parsePomXml(text: string): ParseResult {
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  if (!/<project[\s>]/.test(xml)) throw new LockfileParseError("pom-xml", "no <project> element");

  // Plugin dependencies (<build>, <reporting>) are the build's own classpath, not the project's.
  const body = strip(strip(xml, "build"), "reporting");
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(body)?.[1] ?? "";
  // The project's own coordinates: the top level, with the parent and every list removed.
  const top = ["parent", "dependencies", "dependencyManagement", "properties", "profiles", "modules", "licenses", "developers", "distributionManagement", "repositories", "pluginRepositories"].reduce(strip, body);

  const props = new Map<string, string>();
  for (const block of body.matchAll(/<properties>([\s\S]*?)<\/properties>/g)) {
    for (const m of block[1].matchAll(/<([A-Za-z0-9_.-]+)>\s*([^<]*?)\s*<\/\1>/g)) if (!props.has(m[1])) props.set(m[1], m[2]);
  }
  const version = tag(top, "version") ?? tag(parent, "version");
  const groupId = tag(top, "groupId") ?? tag(parent, "groupId");
  if (version !== undefined) props.set("project.version", version);
  if (groupId !== undefined) props.set("project.groupId", groupId);

  const resolve = propertyResolver(props);

  const out = new ResultBuilder();
  for (const m of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const dep = m[1];
    const raw = dep.replace(/\s+/g, " ").trim().slice(0, 200);
    const g = resolve(tag(dep, "groupId") ?? "");
    const a = resolve(tag(dep, "artifactId") ?? "");
    const v = tag(dep, "version");
    if (!g || !a) {
      out.skip(raw, UNRESOLVED);
      continue;
    }
    if (v === undefined || v === "") {
      out.skip(raw, "no version (managed by a parent)");
      continue;
    }
    const resolved = resolve(v);
    if (resolved === undefined || resolved === "") out.skip(raw, UNRESOLVED);
    else if (/^[[(]/.test(resolved)) out.skip(raw, "version range");
    else out.add("Maven", `${g}:${a}`, resolved);
  }
  return out.build();
}
