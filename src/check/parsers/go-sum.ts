import { ResultBuilder, type ParseResult } from "./types";

/** go.sum: `<module> <version>[/go.mod] <hash>` lines. The `/go.mod` line of a module counts once with its zip line. */
export function parseGoSum(text: string): ParseResult {
  const out = new ResultBuilder();
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 3) {
      out.skip(trimmed, "not a go.sum line", i + 1);
      return;
    }
    out.add("Go", fields[0], fields[1].replace(/\/go\.mod$/, ""));
  });
  return out.build();
}
