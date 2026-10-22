// A fake world for the GitHub Action tests: a temp checkout with real files,
// real step-summary and output files, and a fetch that answers only the fake
// Tocsin API and the fake GitHub API. Any other URL throws, so no test reaches
// the network.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: RequestInit["body"];
}

export interface Comment {
  id: number;
  body: string;
}

export interface World {
  dir: string;
  env: Record<string, string>;
  stdout: string[];
  calls: Call[];
  comments: Comment[];
  /** The fake Tocsin answer for POST /v1/check. */
  check: () => Response;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  out(line: string): void;
  summary(): Promise<string>;
  outputs(): Promise<string>;
  cleanup(): Promise<void>;
}

export const API = "https://api.tocsin.test";
export const GH = "https://api.github.test";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function world(opts: { event?: string; inputs?: Record<string, string> } = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "tocsin-action-"));
  const workspace = join(root, "repo");
  await mkdir(workspace);
  const summaryPath = join(root, "summary.md");
  const outputPath = join(root, "output.txt");
  const eventPath = join(root, "event.json");
  await writeFile(summaryPath, "");
  await writeFile(outputPath, "");
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 42 } }));
  let nextId = 100;
  const w: World = {
    dir: workspace,
    env: {
      GITHUB_WORKSPACE: workspace,
      GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_EVENT_NAME: opts.event ?? "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_API_URL: GH,
      TOCSIN_GITHUB_TOKEN: "ghs_fake",
      TOCSIN_BASE_URL: API,
      ...opts.inputs,
    },
    stdout: [],
    calls: [],
    comments: [],
    check: () => json({ checked: 0, affected: [], skipped: [], feed_cursor: 1 }),
    out(line) {
      w.stdout.push(line);
    },
    async fetch(url, init = {}) {
      const headers: Record<string, string> = {};
      for (const [k, v] of new Headers(init.headers as HeadersInit)) headers[k.toLowerCase()] = v;
      const call: Call = { method: init.method ?? "GET", url: new URL(url), headers, body: init.body };
      w.calls.push(call);
      const p = call.url.pathname;
      if (call.url.origin === API && call.method === "POST" && p === "/v1/check") return w.check();
      if (call.url.origin === GH) {
        if (call.method === "GET" && p === "/repos/acme/widget/issues/42/comments") {
          const page = Number(call.url.searchParams.get("page") ?? "1");
          return json(page === 1 ? w.comments.map((c) => ({ ...c, user: { login: "github-actions[bot]" } })) : []);
        }
        if (call.method === "POST" && p === "/repos/acme/widget/issues/42/comments") {
          const c = { id: nextId++, body: JSON.parse(String(call.body)).body as string };
          w.comments.push(c);
          return json(c, 201);
        }
        const m = /^\/repos\/acme\/widget\/issues\/comments\/(\d+)$/.exec(p);
        if (call.method === "PATCH" && m) {
          const c = w.comments.find((x) => x.id === Number(m[1]));
          if (!c) return json({ message: "Not Found" }, 404);
          c.body = JSON.parse(String(call.body)).body;
          return json(c);
        }
      }
      throw new Error(`fake world: unrouted ${call.method} ${url}`);
    },
    summary: () => readFile(summaryPath, "utf8"),
    outputs: () => readFile(outputPath, "utf8"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
  return w;
}
