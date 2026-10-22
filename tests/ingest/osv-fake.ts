// Test-mode fake for the OSV seam (src/ingest/osv-client.ts). It serves the
// per-ecosystem modified_id.csv and /v1/vulns/<id> from in-memory records and
// throws on any other URL, so a test that uses it makes 0 network calls.

export const FAKE_CSV_BASE = "https://osv-csv.fake";
export const FAKE_API_BASE = "https://osv-api.fake";

export interface FakeRecord {
  id: string;
  modified: string;
  affected?: { package?: { ecosystem?: string; name?: string } }[];
  [k: string]: unknown;
}

export interface CsvRow {
  ecosystem: string;
  modified: string;
  id: string;
}

export interface OsvFake {
  fetch: typeof fetch;
  calls: string[];
  vulnCalls(): string[];
}

export interface OsvFakeOptions {
  // Extra CSV rows with no record behind them (or with a failing record).
  extraRows?: CsvRow[];
  // Ids whose /v1/vulns/ fetch answers with this HTTP status.
  failIds?: Record<string, number>;
}

function modKeyForSort(ts: string): string {
  const m = /^(.*?)(?:\.(\d+))?Z$/.exec(ts);
  return m ? `${m[1]}.${(m[2] ?? "").padEnd(9, "0")}` : ts;
}

export function createOsvFake(records: FakeRecord[], opts: OsvFakeOptions = {}): OsvFake {
  const rows: CsvRow[] = [];
  for (const r of records) {
    const ecos = new Set((r.affected ?? []).map((a) => a.package?.ecosystem).filter((e): e is string => !!e));
    for (const ecosystem of ecos) rows.push({ ecosystem, modified: r.modified, id: r.id });
  }
  rows.push(...(opts.extraRows ?? []));
  const byId = new Map(records.map((r) => [r.id, r]));
  const calls: string[] = [];

  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.startsWith(`${FAKE_CSV_BASE}/`) && url.endsWith("/modified_id.csv")) {
      const eco = decodeURIComponent(url.slice(FAKE_CSV_BASE.length + 1, -"/modified_id.csv".length));
      const lines = rows
        .filter((r) => r.ecosystem === eco)
        .sort((a, b) => (modKeyForSort(b.modified) < modKeyForSort(a.modified) ? -1 : 1))
        .map((r) => `${r.modified},${r.id}\n`)
        .join("");
      return new Response(lines, { status: 200, headers: { "content-type": "text/csv" } });
    }
    if (url.startsWith(`${FAKE_API_BASE}/v1/vulns/`)) {
      const id = decodeURIComponent(url.slice(`${FAKE_API_BASE}/v1/vulns/`.length));
      const status = opts.failIds?.[id];
      if (status) return new Response("upstream error", { status });
      const rec = byId.get(id);
      if (!rec) return new Response('{"code":5,"message":"Bug not found."}', { status: 404 });
      return new Response(JSON.stringify(rec), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`osv-fake: unexpected URL ${url}`);
  };

  return {
    fetch: fakeFetch as typeof fetch,
    calls,
    vulnCalls: () => calls.filter((c) => c.startsWith(`${FAKE_API_BASE}/v1/vulns/`)),
  };
}
