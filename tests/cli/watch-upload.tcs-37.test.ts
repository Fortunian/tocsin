// TCS-37: `tocsin watch --upload` sends the lockfiles in cwd to the key's
// default watch list, and `tocsin watch` prints the list status once at start.
// The fake io answers every call; 0 network calls.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../packages/cli/src/cli.js";
import { fakeIo, json, type FakeIo, type FetchCall } from "./helpers.tcs-13.js";

const KEY = "tcs_fixture_key";
const LIST_ID = "wl_fixture_default";
const OTHER_ID = "wl_fixture_other";
const DELIVERED_AT = "2026-10-01T00:00:00.000Z";

// A lockfileVersion 3 file with 3 packages.
const LOCKFILE = JSON.stringify(
  {
    name: "watch-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "watch-fixture", version: "1.0.0", dependencies: { lodash: "4.17.20", minimist: "1.2.5", ms: "2.1.2" } },
      "node_modules/lodash": { version: "4.17.20" },
      "node_modules/minimist": { version: "1.2.5" },
      "node_modules/ms": { version: "2.1.2" },
    },
  },
  null,
  2,
);

const AFFECTED = {
  dependency: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
  advisory_id: "tcs_01JA0000000000000000000001",
  severity: { score: 7.2, label: "high" },
  exploited: false,
  fixed_in: "4.17.21",
  action: "Upgrade lodash to 4.17.21 or later.",
  url: "https://example.com/fixture/lodash",
};

const BASE_EVENT = JSON.parse(readFileSync(new URL("../fixtures/advisory/valid.json", import.meta.url), "utf8"));
const EVENT = { ...BASE_EVENT, id: "tcs_01JA00000000000000000000E1" };

let io: FakeIo | undefined;
afterEach(async () => {
  await io?.cleanup();
  io = undefined;
});

async function setup(argv: string[], env: Record<string, string> = { TOCSIN_API_KEY: KEY }, lockfile = true): Promise<FakeIo> {
  io = await fakeIo(argv, env);
  if (lockfile) await writeFile(join(io.cwd, "package-lock.json"), LOCKFILE);
  return io;
}

const list = (id: string, name: string) => ({ id, name, delivery: "poll", created_at: "2026-09-01T00:00:00.000Z" });
const path = (c: FetchCall) => `${c.method} ${c.url.pathname}`;
const isWatchlistCall = (c: FetchCall) => c.url.pathname.startsWith("/v1/watchlists");

interface Server {
  lists: { id: string; name: string }[];
  upload?: () => Response;
  lastDeliveryAt?: string | null;
  listFails?: boolean;
}

// The watch-list routes of the API, answered from seeded data.
function serve(io: FakeIo, s: Server): void {
  io.routes.push((c) => {
    const p = c.url.pathname;
    if (c.method === "GET" && p === "/v1/watchlists") {
      if (s.listFails) return json({ error: "internal error" }, 500);
      return json({ watchlists: s.lists.map((l) => list(l.id, l.name)) });
    }
    if (c.method === "POST" && p === "/v1/watchlists") {
      const name = (JSON.parse(String(c.body)) as { name: string }).name;
      s.lists.push({ id: LIST_ID, name });
      return json({ ...list(LIST_ID, name), cursor: 0 }, 201);
    }
    if (c.method === "POST" && p.endsWith("/lockfile")) {
      if (s.upload) return s.upload();
      return json({ dependencies: 3, affected: [AFFECTED], skipped: [], feed_cursor: 7 });
    }
    const id = /^\/v1\/watchlists\/([^/]+)$/.exec(p)?.[1];
    if (c.method === "GET" && id) {
      return json({ ...list(id, "default"), dependencies: 3, dependencies_uploaded_at: "2026-10-23T00:00:00.000Z", last_delivery_at: s.lastDeliveryAt ?? null });
    }
    return undefined;
  });
}

describe("tocsin watch --upload", () => {
  it("creates the default list when absent, uploads the lockfile, prints the status", async () => {
    const io = await setup(["watch", "--upload"]);
    const server: Server = { lists: [] };
    serve(io, server);
    expect(await main(io)).toBe(0);
    expect(io.calls.map(path)).toEqual([
      "GET /v1/watchlists",
      "POST /v1/watchlists",
      `POST /v1/watchlists/${LIST_ID}/lockfile`,
      "GET /v1/watchlists",
      `GET /v1/watchlists/${LIST_ID}`,
    ]);
    const create = io.calls[1];
    expect(JSON.parse(String(create.body))).toEqual({ name: "default" });
    expect(create.headers["content-type"]).toBe("application/json");
    const form = io.calls[2].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()]).toEqual(["package-lock.json"]);
    expect(await (form.get("package-lock.json") as Blob).text()).toBe(LOCKFILE);
    expect(io.calls.every((c) => c.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    const { out, err } = io.text();
    expect(out).toContain(`uploaded 3 dependencies to watch list default (${LIST_ID}), 1 affected now`);
    expect(out).toContain("watching 3 dependencies, last delivery at never");
    expect(out + err).not.toContain(KEY);
  });

  it("uploads to the existing list named default, never creates one", async () => {
    const io = await setup(["watch", "--upload"]);
    serve(io, { lists: [{ id: OTHER_ID, name: "other" }, { id: LIST_ID, name: "default" }], lastDeliveryAt: DELIVERED_AT });
    expect(await main(io)).toBe(0);
    expect(io.calls.filter((c) => path(c) === "POST /v1/watchlists")).toHaveLength(0);
    const uploads = io.calls.filter((c) => c.url.pathname.endsWith("/lockfile"));
    expect(uploads.map((c) => c.url.pathname)).toEqual([`/v1/watchlists/${LIST_ID}/lockfile`]);
    expect(io.calls.some((c) => c.url.pathname.includes(OTHER_ID))).toBe(false);
    expect(io.text().out).toContain(`watching 3 dependencies, last delivery at ${DELIVERED_AT}`);
  });

  it("no key exits 2 with 0 calls; no lockfile exits 2 with no upload", async () => {
    let io = await setup(["watch", "--upload"], {});
    serve(io, { lists: [] });
    expect(await main(io)).toBe(2);
    expect(io.calls).toHaveLength(0);
    expect(io.text().err).toContain("TOCSIN_API_KEY");
    await io.cleanup();

    io = await setup(["watch", "--upload"], { TOCSIN_API_KEY: KEY }, false);
    serve(io, { lists: [] });
    expect(await main(io)).toBe(2);
    expect(io.calls.filter((c) => c.url.pathname.endsWith("/lockfile"))).toHaveLength(0);
    expect(io.text().err).toContain("no lockfile");
  });

  it("a 413 names the dependency limit and exits 3", async () => {
    const io = await setup(["watch", "--upload"]);
    serve(io, {
      lists: [{ id: LIST_ID, name: "default" }],
      upload: () => json({ error: "dependency limit reached", max_watch_dependencies: 2000, dependencies: 2500 }, 413),
    });
    expect(await main(io)).toBe(3);
    const err = io.stderr.filter((l) => l !== "");
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("413");
    expect(err[0]).toContain("2000");
    expect(io.text().out).not.toContain("uploaded");
  });

  it("a failed list read exits 3 and is never read as no list", async () => {
    const io = await setup(["watch", "--upload"]);
    serve(io, { lists: [], listFails: true });
    expect(await main(io)).toBe(3);
    expect(io.calls.map(path)).toEqual(["GET /v1/watchlists"]);
    expect(io.text().err).toContain("500");
  });
});

describe("tocsin watch status line", () => {
  function events(io: FakeIo): void {
    io.routes.push((c) => {
      if (c.url.pathname !== "/v1/events") return undefined;
      if (c.url.searchParams.get("order") === "desc") return json({ events: [], next_cursor: 10, has_more: false });
      return json({ events: [EVENT], next_cursor: 11, has_more: false });
    });
  }

  it("with a key, prints the status on stderr once before the first poll", async () => {
    const io = await setup(["watch"]);
    io.maxPolls = 1;
    serve(io, { lists: [{ id: LIST_ID, name: "default" }], lastDeliveryAt: DELIVERED_AT });
    events(io);
    expect(await main(io)).toBe(0);
    const status = `watching 3 dependencies, last delivery at ${DELIVERED_AT}`;
    expect(io.stderr[0]).toBe(status);
    expect(io.stderr.filter((l) => l === status)).toHaveLength(1);
    const firstEvents = io.calls.findIndex((c) => c.url.pathname === "/v1/events");
    const lastWatchlist = io.calls.map(isWatchlistCall).lastIndexOf(true);
    expect(lastWatchlist).toBeLessThan(firstEvents);
    expect(io.calls.filter((c) => c.url.pathname === "/v1/events")).toHaveLength(2);
    expect(io.text().out.split("\n").filter((l) => l !== "")).toHaveLength(1);
    expect(io.text().out).toContain(EVENT.id);
    expect(io.text().out).not.toContain("watching");
  });

  it("with a key and no default list, prints 0 dependencies", async () => {
    const io = await setup(["watch"]);
    io.maxPolls = 1;
    serve(io, { lists: [{ id: OTHER_ID, name: "other" }] });
    events(io);
    expect(await main(io)).toBe(0);
    expect(io.stderr[0]).toBe("watching 0 dependencies, last delivery at never");
    expect(io.calls.some((c) => c.url.pathname.includes(OTHER_ID))).toBe(false);
  });

  it("without a key, no status line and no watch-list call", async () => {
    const io = await setup(["watch"], {});
    io.maxPolls = 1;
    serve(io, { lists: [{ id: LIST_ID, name: "default" }] });
    events(io);
    expect(await main(io)).toBe(0);
    expect(io.calls.filter(isWatchlistCall)).toHaveLength(0);
    expect(io.text().err).not.toContain("watching");
    expect(io.text().out).toContain(EVENT.id);
  });

  it("a failed status read prints one stderr line and polling still runs", async () => {
    const io = await setup(["watch"]);
    io.maxPolls = 1;
    serve(io, { lists: [], listFails: true });
    events(io);
    expect(await main(io)).toBe(0);
    const err = io.stderr.filter((l) => l !== "");
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^watch: status failed: 500/);
    expect(io.text().out).toContain(EVENT.id);
  });
});
