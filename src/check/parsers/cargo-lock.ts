import { ResultBuilder, type ParseResult } from "./types";

/** Cargo.lock: `[[package]]` blocks. Only packages with a `registry+` or `sparse+` source are dependencies. */
export function parseCargoLock(text: string): ParseResult {
  const out = new ResultBuilder();
  const blocks = text.split(/^\[\[package\]\][ \t]*$/m).slice(1);
  for (const block of blocks) {
    const body = block.split(/^\[/m)[0];
    const name = field(body, "name");
    const version = field(body, "version");
    if (!name || !version) {
      out.skip(body.trim().slice(0, 200), "package without name or version");
      continue;
    }
    const source = field(body, "source");
    if (source?.startsWith("registry+") || source?.startsWith("sparse+")) out.add("crates.io", name, version);
    else out.skip(`${name} ${version}`, "not from a registry");
  }
  return out.build();
}

function field(body: string, key: string): string | undefined {
  return new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(body)?.[1];
}
