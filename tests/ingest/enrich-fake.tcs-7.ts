// Test-mode fakes for the NVD, KEV and EPSS seams (src/ingest/nvd.ts,
// kev.ts, epss.ts). Each one answers only its own fake host and throws on any
// other URL, so a test that uses them makes 0 network calls.
import nvdScored from "../fixtures/nvd/cve-score-9.2.json";
import nvdNoMetrics from "../fixtures/nvd/cve-no-metrics.json";
import nvdNoResults from "../fixtures/nvd/no-results.json";
import kevFeed from "../fixtures/kev/feed.json";
import epssCsv from "../fixtures/epss/scores.csv?raw";

export const FAKE_NVD_BASE = "https://nvd-api.fake/rest/json/cves/2.0";
export const FAKE_KEV_URL = "https://kev-feed.fake/known_exploited_vulnerabilities.json";
export const FAKE_EPSS_URL = "https://epss-csv.fake/epss_scores-current.csv.gz";
export const FAKE_EPSS_PLAIN_URL = "https://epss-csv.fake/epss_scores-current.csv";

export const NVD_FIXTURE_CVE = "CVE-2026-90001";
export const NVD_NO_METRICS_CVE = "CVE-2026-90002";
export const EPSS_FIXTURE_TEXT: string = epssCsv;

export type NvdAnswer = "scored" | "no-metrics" | "no-results" | number;

export interface NvdCall {
  url: string;
  cve: string;
  apiKey: string | null;
}

export interface NvdFake {
  fetch: typeof fetch;
  calls: NvdCall[];
}

// The recorded-shape body with the requested CVE id swapped in.
function nvdBody(answer: "scored" | "no-metrics" | "no-results", cve: string): string {
  const src = answer === "scored" ? nvdScored : answer === "no-metrics" ? nvdNoMetrics : nvdNoResults;
  const fixtureId = answer === "scored" ? NVD_FIXTURE_CVE : NVD_NO_METRICS_CVE;
  return JSON.stringify(src).split(fixtureId).join(cve);
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

// answers: CVE id -> what NVD answers. A CVE not in the map answers "scored".
export function createNvdFake(answers: Record<string, NvdAnswer> = {}): NvdFake {
  const calls: NvdCall[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (!url.startsWith(`${FAKE_NVD_BASE}?`)) throw new Error(`nvd-fake: unexpected URL ${url}`);
    const cve = new URL(url).searchParams.get("cveId") ?? "";
    const apiKey = new Headers(init?.headers).get("apiKey");
    calls.push({ url, cve, apiKey });
    const answer = answers[cve] ?? "scored";
    if (typeof answer === "number") return new Response("fixture upstream error", { status: answer });
    return new Response(nvdBody(answer, cve), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fakeFetch as typeof fetch, calls };
}

export interface SimpleFake {
  fetch: typeof fetch;
  calls: string[];
}

// Serves a KEV feed body (default: the fixture) at FAKE_KEV_URL.
export function createKevFake(opts: { body?: unknown; status?: number } = {}): SimpleFake {
  const calls: string[] = [];
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    if (url !== FAKE_KEV_URL) throw new Error(`kev-fake: unexpected URL ${url}`);
    calls.push(url);
    if (opts.status && opts.status !== 200) return new Response("<html>fixture error page</html>", { status: opts.status });
    const body = opts.body === undefined ? kevFeed : opts.body;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fakeFetch as typeof fetch, calls };
}

function gzip(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
}

// Serves CSV text gzipped at FAKE_EPSS_URL and plain at FAKE_EPSS_PLAIN_URL.
export function createEpssFake(text: string = EPSS_FIXTURE_TEXT, opts: { status?: number } = {}): SimpleFake {
  const calls: string[] = [];
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    if (url !== FAKE_EPSS_URL && url !== FAKE_EPSS_PLAIN_URL) throw new Error(`epss-fake: unexpected URL ${url}`);
    calls.push(url);
    if (opts.status && opts.status !== 200) return new Response("fixture error", { status: opts.status });
    const body = url === FAKE_EPSS_URL ? gzip(text) : text;
    return new Response(body, { status: 200, headers: { "content-type": url === FAKE_EPSS_URL ? "application/gzip" : "text/csv" } });
  };
  return { fetch: fakeFetch as typeof fetch, calls };
}
