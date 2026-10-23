#!/usr/bin/env node
// run.mjs: the one-time OSV backfill of one ecosystem (TCS-32). It downloads
// <OSV_BASE>/<eco>/all.zip and posts the records to <TOCSIN_URL>/v1/internal/import
// in batches. A rerun resumes after the last batch the server recorded.
// .github/workflows/backfill.yml runs it; docs/BACKFILL.md has the operator steps.
//
// Env:
//   IMPORT_TOKEN    the worker secret IMPORT_TOKEN (required)
//   TOCSIN_URL      the Tocsin host                         default https://tocsin.sh
//   OSV_BASE        the OSV export bucket                   default https://osv-vulnerabilities.storage.googleapis.com
//   IMPORT_RETRIES  retries of a 5xx or network error       default 3
//   IMPORT_BACKOFF_MS  first retry wait, doubled each time  default 2000
// The server's settings row import.max_batch caps --batch.
//
//   IMPORT_TOKEN=... node scripts/backfill/run.mjs --ecosystem npm [--batch 100]
//
// Exit 0 when the final batch is recorded (done_at set). Exit 1 on a 4xx at
// once, on a 5xx or network error after the retries, or on bad input.
import { parseArgs } from "node:util";
import { runBackfill } from "./osv-import.mjs";

const DEFAULTS = { tocsin: "https://tocsin.sh", osv: "https://osv-vulnerabilities.storage.googleapis.com", batch: 100, retries: 3, backoffMs: 2000 };

function fail(msg) {
  console.error(`backfill: ${msg}`);
  process.exit(1);
}

function posInt(name, raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) fail(`${name} must be a positive integer, got '${raw}'`);
  return Number(raw);
}

class HttpError extends Error {
  constructor(status, text) {
    super(`HTTP ${status}: ${text.slice(0, 300)}`);
    this.status = status;
  }
}

async function request(url, init, retries, backoffMs) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const text = await res.text();
      // A 4xx is a request the server refuses: a retry gets the same answer.
      if (res.status < 500) throw new HttpError(res.status, text);
      if (attempt >= retries) throw new HttpError(res.status, text);
      console.error(`backfill: ${init.method ?? "GET"} ${url}: HTTP ${res.status}, retry ${attempt + 1} of ${retries}`);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (attempt >= retries) throw err;
      console.error(`backfill: ${init.method ?? "GET"} ${url}: ${err.message}, retry ${attempt + 1} of ${retries}`);
    }
    await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
  }
}

async function main() {
  const { values } = parseArgs({ options: { ecosystem: { type: "string" }, batch: { type: "string" } } });
  const ecosystem = values.ecosystem;
  if (!ecosystem) fail("--ecosystem is required, for example --ecosystem npm");
  const batch = posInt("--batch", values.batch, DEFAULTS.batch);
  const retries = posInt("IMPORT_RETRIES", process.env.IMPORT_RETRIES, DEFAULTS.retries);
  const backoffMs = posInt("IMPORT_BACKOFF_MS", process.env.IMPORT_BACKOFF_MS, DEFAULTS.backoffMs);
  const token = (process.env.IMPORT_TOKEN ?? "").trim();
  if (token === "") fail("IMPORT_TOKEN is not set");
  const tocsin = (process.env.TOCSIN_URL || DEFAULTS.tocsin).replace(/\/+$/, "");
  const osv = (process.env.OSV_BASE || DEFAULTS.osv).replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${token}` };

  const zipUrl = `${osv}/${encodeURIComponent(ecosystem)}/all.zip`;
  console.log(`backfill: ${ecosystem}: download ${zipUrl}`);
  const zip = new Uint8Array(await (await request(zipUrl, { method: "GET" }, retries, backoffMs)).arrayBuffer());
  console.log(`backfill: ${ecosystem}: ${zip.length} bytes`);

  const totals = await runBackfill({
    zip,
    ecosystem,
    batch,
    log: (line) => console.log(`backfill: ${line}`),
    get: async () => (await request(`${tocsin}/v1/internal/import/${encodeURIComponent(ecosystem)}`, { method: "GET", headers: auth }, retries, backoffMs)).json(),
    post: async (body) =>
      (
        await request(
          `${tocsin}/v1/internal/import`,
          { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) },
          retries,
          backoffMs,
        )
      ).json(),
  });
  if (!totals.done_at) fail(`${ecosystem}: the final batch answered no done_at`);
  console.log(`backfill: ${ecosystem}: done at ${totals.done_at}: ${totals.imported} imported, ${totals.unchanged} unchanged, ${totals.skipped} skipped, ${totals.errors} errors in ${totals.posts} requests`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
