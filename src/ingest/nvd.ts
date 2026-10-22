// The NVD ingester: for advisories with a CVE but no severity score, it asks
// the NVD CVE API 2.0 for that CVE and writes the CVSS base score and label.
// This file is the NVD seam: the only code that builds an NVD URL.
// Dedup before spend: a scored advisory leaves the candidate query, and a CVE
// NVD answered without a score is marked in KV for `requery_hours`.
import { checked, appendSource, canonicalJson, UPSERT_SQL } from "./upsert";
import { posIntConfig, urlConfig } from "./config";
import { cvePageSql, readCvePage } from "./cve-page";
import type { IngestContext, Ingester, RunResult } from "./types";
import type { Advisory } from "../schema/advisory";
import { labelFromScore } from "../schema/severity";

export const NVD_SCAN_KEY = "cursor:nvd";
export const nvdQueriedKey = (cve: string) => `nvd:queried:${cve}`;

// Code fallbacks for sources.config_json of row "nvd" (repo iron rule 5).
// NVD allows 50 requests per 30 s with an API key and 5 without; the cron
// runs every 10 minutes, so one run's calls always fit in one window.
const DEFAULTS = {
  api_base: "https://services.nvd.nist.gov/rest/json/cves/2.0",
  max_requests_with_key: 50,
  max_requests_without_key: 5,
  scan_limit: 500,
  requery_hours: 24,
};

// idx_advisories_nvd_pending (partial index, migrations/0007).
export const NVD_SQL = cvePageSql("id, cve_primary, doc_json", "severity_score IS NULL AND cve_primary IS NOT NULL");
const UPDATE_SQL = `UPDATE advisories SET severity_score = ?, severity_label = ?, doc_json = ?, cursor = ${UPSERT_SQL.nextCursor} WHERE id = ? AND severity_score IS NULL`;

interface Candidate {
  id: string;
  cve_primary: string;
  doc_json: string;
}

interface NvdMetric {
  type?: unknown;
  cvssData?: { baseScore?: unknown };
}

// CVSS v3.1, then v3.0, then v4.0; in each list the NVD "Primary" entry first.
// v2 uses other severity bands and is ignored.
const METRIC_KEYS = ["cvssMetricV31", "cvssMetricV30", "cvssMetricV40"] as const;

export class NvdFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NvdFormatError";
  }
}

// The base score NVD gives for `cve`, or undefined when it has none.
// A body that is not an NVD 2.0 answer for this CVE throws NvdFormatError.
export function pickNvdScore(body: unknown, cve: string): number | undefined {
  const vulns = (body as { vulnerabilities?: unknown } | null)?.vulnerabilities;
  if (!Array.isArray(vulns)) throw new NvdFormatError(`${cve}: NVD answer has no vulnerabilities list`);
  if (vulns.length === 0) return undefined;
  const record = (vulns[0] as { cve?: { id?: unknown; metrics?: Record<string, unknown> } })?.cve;
  if (record?.id !== cve) throw new NvdFormatError(`${cve}: NVD answered for ${String(record?.id)}`);
  for (const key of METRIC_KEYS) {
    const list = record.metrics?.[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const entry = (list as NvdMetric[]).find((m) => m?.type === "Primary") ?? (list[0] as NvdMetric);
    const score = entry?.cvssData?.baseScore;
    if (typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 10) return score;
  }
  return undefined;
}

function readConfig(raw: Record<string, unknown>, hasKey: boolean) {
  return {
    api_base: urlConfig(raw, "nvd", "api_base", DEFAULTS.api_base),
    max_requests_per_run: posIntConfig(raw, "nvd", "max_requests_per_run", hasKey ? DEFAULTS.max_requests_with_key : DEFAULTS.max_requests_without_key),
    scan_limit: posIntConfig(raw, "nvd", "scan_limit", DEFAULTS.scan_limit),
    requery_hours: posIntConfig(raw, "nvd", "requery_hours", DEFAULTS.requery_hours),
  };
}

function scoredDoc(row: Candidate, cve: string, score: number): Advisory {
  const doc = JSON.parse(row.doc_json) as Advisory;
  return checked({
    ...doc,
    severity: { score, label: labelFromScore(score) },
    sources: appendSource(doc.sources, { source: "nvd", source_id: cve, url: `https://nvd.nist.gov/vuln/detail/${cve}` }),
  });
}

async function run(ctx: IngestContext): Promise<RunResult> {
  const apiKey = ctx.env.NVD_API_KEY?.trim() || undefined;
  const cfg = readConfig(ctx.source.config, apiKey !== undefined);
  const kv = ctx.env.CURSORS;
  const db = ctx.env.DB;
  const result: RunResult = { fetched: 0, upserted: 0, unchanged: 0, errors: [] };

  const after = (await kv.get(NVD_SCAN_KEY)) ?? "";
  const page = await readCvePage<Candidate>(db, NVD_SQL, after, cfg.scan_limit);
  // The last CVE this run examined fully. The scan resumes after it, so CVEs
  // marked in KV never starve the ones behind them.
  let examined: string | undefined;
  let stopped = false;

  for (const [index, [cve, rows]] of page.groups.entries()) {
    if ((await kv.get(nvdQueriedKey(cve))) !== null) {
      result.unchanged += rows.length;
      examined = cve;
      continue;
    }
    if (result.fetched >= cfg.max_requests_per_run) {
      result.deferred = page.groups.length - index;
      stopped = true;
      break;
    }

    result.fetched += 1;
    let score: number | undefined;
    try {
      const res = await ctx.fetch(`${cfg.api_base}?cveId=${encodeURIComponent(cve)}`, {
        headers: apiKey ? { apiKey } : {},
      });
      if (res.status === 404) {
        score = undefined;
      } else if (!res.ok) {
        // 403 / 429 / 5xx: rate limit or outage. Nothing is marked; stop here.
        throw new Error(`NVD HTTP ${res.status}`);
      } else {
        score = pickNvdScore(await res.json(), cve);
      }
    } catch (err) {
      result.errors.push(`${cve}: ${err instanceof Error ? err.message : String(err)}`);
      result.deferred = page.groups.length - index;
      stopped = true;
      break;
    }

    if (score === undefined) {
      result.unchanged += rows.length;
    } else {
      const docs: Advisory[] = [];
      try {
        for (const row of rows) docs.push(scoredDoc(row, cve, score));
      } catch (err) {
        // A stored doc that fails validation is a data problem for this CVE only.
        result.errors.push(`${cve}: ${err instanceof Error ? err.message : String(err)}`);
        examined = cve;
        continue;
      }
      const writes = await db.batch(
        docs.map((doc, i) => db.prepare(UPDATE_SQL).bind(score, doc.severity.label, canonicalJson(doc), rows[i].id)),
      );
      for (const w of writes) result.upserted += w.meta.changes ?? 0;
    }
    // Marked after the D1 write: a crash between the two costs one extra call,
    // never a CVE marked as answered whose score was not stored.
    await kv.put(nvdQueriedKey(cve), ctx.now().toISOString(), { expirationTtl: cfg.requery_hours * 3600 });
    examined = cve;
  }

  if (!stopped && !page.more) {
    // The scan reached the end of the candidates: the next run starts over.
    await kv.put(NVD_SCAN_KEY, "");
  } else if (examined !== undefined) {
    await kv.put(NVD_SCAN_KEY, examined);
  }
  result.incomplete = stopped || page.more;
  return result;
}

export const nvd: Ingester = { id: "nvd", run };
