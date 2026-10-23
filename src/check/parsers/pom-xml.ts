import { LockfileParseError, ResultBuilder, type ParseResult } from "./types";

// pom.xml is not a lockfile: it lists direct dependencies only. A version is
// read when it is a literal or a property defined in this same file
// (${project.version} and ${project.groupId} included). A version managed by a
// parent POM, an unknown property or a version range is skipped with its
// reason, never guessed. Regex parse (no XML library in the Worker bundle).

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml);
  return m ? m[1] : undefined;
};

// Removes every <name>...</name> block (non-nested tags only).
const strip = (xml: string, name: string) => xml.replace(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, "g"), "");

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

  // Resolves ${name} references; a cycle or an unknown name is unresolved.
  const resolve = (value: string, seen: Set<string> = new Set()): string | undefined => {
    let ok = true;
    const out = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      const v = props.get(name);
      if (v === undefined || seen.has(name)) {
        ok = false;
        return "";
      }
      const r = resolve(v, new Set([...seen, name]));
      if (r === undefined) ok = false;
      return r ?? "";
    });
    return ok ? out : undefined;
  };

  const out = new ResultBuilder();
  for (const m of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const dep = m[1];
    const raw = dep.replace(/\s+/g, " ").trim().slice(0, 200);
    const g = resolve(tag(dep, "groupId") ?? "");
    const a = resolve(tag(dep, "artifactId") ?? "");
    const v = tag(dep, "version");
    if (!g || !a) {
      out.skip(raw, "unresolved property");
      continue;
    }
    if (v === undefined || v === "") {
      out.skip(raw, "no version (managed by a parent)");
      continue;
    }
    const resolved = resolve(v);
    if (resolved === undefined || resolved === "") out.skip(raw, "unresolved property");
    else if (/^[[(]/.test(resolved)) out.skip(raw, "version range");
    else out.add("Maven", `${g}:${a}`, resolved);
  }
  return out.build();
}
