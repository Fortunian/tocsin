// Test helper for the launch check (TCS-14). It runs the real worker
// (src/index.ts) in Miniflare on a localhost port, applies migrations/, and
// seeds it through the production cron path (worker.scheduled) with the
// 2026-10-21 Node and PHP fixtures. Every outbound fetch the worker makes is
// answered from the fixture files; any other URL gets a 599 and is recorded in
// unknownUrls, so a test can assert 0 vendor calls.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { build } from "esbuild";
import { Miniflare, Response as MfResponse } from "miniflare";

const ROOT = join(import.meta.dirname, "..", "..");
const fixture = (p: string) => readFileSync(join(ROOT, "tests", "fixtures", p), "utf8");

// The same URL map as tests/cron/runtime-ingest.tcs-6.test.ts (ROUTES).
const ROUTES: Record<string, string> = {
  "https://nodejs.org/en/feed/vulnerability.xml": fixture("node-runtime/vulnerability.xml"),
  "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases": fixture("node-runtime/2026-10-21.html"),
  "https://nodejs.org/dist/index.json": fixture("node-runtime/index.json"),
  "https://www.php.net/index.php": fixture("php-runtime/2026-10-21.html"),
  "https://www.php.net/releases/feed.php": fixture("php-runtime/releases.xml"),
  "https://api.github.com/repos/php/php-src/security-advisories/GHSA-w8hw-w9fx-j79w": fixture("php-runtime/GHSA-w8hw-w9fx-j79w.json"),
  "https://api.github.com/repos/php/php-src/security-advisories/GHSA-6wmf-4rv5-p3rp": fixture("php-runtime/GHSA-6wmf-4rv5-p3rp.json"),
};
// Both cursors start before the 2026-10-21 posts, so only those posts are read.
const START = "2026-10-01T00:00:00Z";
const RUNTIME_SOURCES = ["node-runtime", "php-runtime"];

function wranglerValue(key: string): string {
  const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
  const m = toml.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
  if (!m) throw new Error(`wrangler.toml has no ${key}`);
  return m[1].trim();
}

let bundled: Promise<string> | undefined;
function bundleWorker(): Promise<string> {
  bundled ??= build({
    entryPoints: [join(ROOT, "src", "index.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:*"],
    write: false,
    logLevel: "silent",
  }).then((r) => r.outputFiles[0].text);
  return bundled;
}

export interface LocalWorker {
  url: string;
  mf: Miniflare;
  db: D1Database;
  unknownUrls: string[];
  dispose(): Promise<void>;
}

export async function startLocalWorker(): Promise<LocalWorker> {
  const unknownUrls: string[] = [];
  // Miniflare 5 option shape: one worker with a config (manifest + env bindings) and dev options.
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    workers: [
      {
        config: {
          name: "tocsin",
          compatibilityDate: JSON.parse(wranglerValue("compatibility_date")) as string,
          compatibilityFlags: JSON.parse(wranglerValue("compatibility_flags")) as string[],
          manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: await bundleWorker() } } },
          env: {
            DB: { type: "d1", id: "tocsin" },
            CURSORS: { type: "kv", id: "cursors" },
            DELIVERIES: { type: "queue", name: "deliveries" },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler: (req) => {
              if (Object.hasOwn(ROUTES, req.url)) return new MfResponse(ROUTES[req.url], { status: 200 });
              unknownUrls.push(req.url);
              return new MfResponse("launch-check fake: unknown URL", { status: 599 });
            },
          },
        },
      },
    ],
  });
  try {
    const url = (await mf.ready).href.replace(/\/$/, "");
    const db = (await mf.getD1Database("DB")) as unknown as D1Database;
    for (const m of await readD1Migrations(join(ROOT, "migrations"))) {
      await db.batch(m.queries.map((q) => db.prepare(q)));
    }

    // Seed: only the two runtime sources run, through the production cron path.
    await db.prepare(`UPDATE sources SET enabled = 0 WHERE id NOT IN ('node-runtime', 'php-runtime')`).run();
    const kv = await mf.getKVNamespace("CURSORS");
    await kv.put("cursor:node-runtime", START);
    await kv.put("cursor:php-runtime", START);
    const worker = await mf.getWorker();
    await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: new Date() });

    const deadline = Date.now() + 15_000;
    for (;;) {
      const ok = await db
        .prepare("SELECT COUNT(*) AS n FROM sources WHERE enabled = 1 AND last_ok_at IS NOT NULL")
        .first<{ n: number }>();
      if (ok?.n === RUNTIME_SOURCES.length) break;
      if (Date.now() > deadline) {
        const rows = await db.prepare("SELECT id, last_error FROM sources WHERE enabled = 1").all();
        throw new Error(`seed cron did not mark both runtime sources ok: ${JSON.stringify(rows.results)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { url, mf, db, unknownUrls, dispose: () => mf.dispose() };
  } catch (err) {
    await mf.dispose();
    throw err;
  }
}
