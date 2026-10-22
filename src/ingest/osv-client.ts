// The OSV vendor seam. This is the only file that builds an OSV URL; the
// fetch function is injected, so tests pass the fake in tests/ingest/osv-fake.ts.

export class OsvHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`OSV HTTP ${status} for ${url}`);
    this.name = "OsvHttpError";
  }
}

export class OsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OsvFormatError";
  }
}

export interface ModifiedRow {
  modified: string;
  id: string;
}

// Reads <base>/<ecosystem>/modified_id.csv (newest first, lines "modified,id")
// and stops at the first line whose modKey(modified) <= sinceKey. Reading more
// than maxRows lines without reaching the cursor throws: nothing is skipped silently.
export async function listModifiedSince(
  fetchFn: typeof fetch,
  base: string,
  ecosystem: string,
  sinceKey: string,
  maxRows: number,
  modKey: (ts: string) => string,
): Promise<ModifiedRow[]> {
  const url = `${base}/${encodeURIComponent(ecosystem)}/modified_id.csv`;
  const res = await fetchFn(url);
  if (!res.ok) throw new OsvHttpError(res.status, url);
  if (!res.body) throw new OsvFormatError(`OSV empty body for ${url}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const rows: ModifiedRow[] = [];
  let buffer = "";
  let done = false;

  // Returns true when the cursor is reached.
  const takeLine = (raw: string): boolean => {
    const line = raw.replace(/\r$/, "");
    if (line === "") return false;
    const comma = line.indexOf(",");
    if (comma <= 0 || comma === line.length - 1) throw new OsvFormatError(`OSV malformed line in ${url}: ${line.slice(0, 120)}`);
    const modified = line.slice(0, comma);
    const id = line.slice(comma + 1);
    if (modKey(modified) <= sinceKey) return true;
    if (rows.length >= maxRows) {
      throw new OsvFormatError(`OSV ${ecosystem}: more than max_csv_rows (${maxRows}) rows newer than the cursor in ${url}`);
    }
    rows.push({ modified, id });
    return false;
  };

  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (buffer !== "") takeLine(buffer);
        break;
      }
      buffer += chunk.value;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (takeLine(line)) {
          done = true;
          break;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return rows;
}

export async function getVuln(fetchFn: typeof fetch, apiBase: string, id: string): Promise<unknown> {
  const url = `${apiBase}/v1/vulns/${encodeURIComponent(id)}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new OsvHttpError(res.status, url);
  return res.json();
}
