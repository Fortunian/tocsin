// TCS-49: a GitHub App installation token gets 403 on GET /user. The Action
// then learns its identity from the author of the first comment it posts,
// stores it in the marker, and updates that comment on later runs.
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MARKER, run } from "../../action/check.mjs";
import { BOT, GH, json, world, type User, type World } from "./helpers.tcs-33.js";

const FIXTURE = new URL("../fixtures/cli/package-lock.json", import.meta.url);
const APP: User = { login: "tocsin-app[bot]", type: "Bot" };
const TAGGED = "<!-- tocsin-check by:tocsin-app[bot] -->";
const COMMENTS = "/repos/acme/widget/issues/42/comments";

const affected = (version: string) => ({
  dependency: { ecosystem: "npm", name: "lodash", version },
  advisory_id: "tcs_01JA0000000000000000000049",
  severity: { label: "high" },
  exploited: false,
  fixed_in: "4.17.21",
  action: "Upgrade lodash to 4.17.21 or later.",
  url: "https://example.com/fixture/lodash",
});
const dirty = (version = "4.17.20") => ({ checked: 2, affected: [affected(version)], skipped: [], feed_cursor: 9 });

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

/**
 * A world where GET /user answers 403 and a POSTed comment is authored by
 * `author` (an App token posts as `<app>[bot]`). `postAnswer` can change what
 * the POST response says; `patch` can answer a PATCH before the fake does.
 */
async function setup(
  opts: {
    author?: User;
    postAnswer?: (c: { id: number; body: string; user?: User }) => unknown;
    patch?: (id: number) => Response | undefined;
  } = {},
): Promise<World> {
  w = await world();
  await copyFile(FIXTURE, join(w.dir, "package-lock.json"));
  w.check = () => json(dirty());
  const inner = w.fetch;
  const author = opts.author ?? APP;
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin === GH && init.method === "PATCH" && opts.patch) {
      const m = /\/issues\/comments\/(\d+)$/.exec(u.pathname);
      const r = m ? opts.patch(Number(m[1])) : undefined;
      if (r) {
        w!.calls.push({ method: "PATCH", url: u, headers: {}, body: init.body });
        return r;
      }
    }
    const res = await inner(url, init);
    if (u.origin === GH && init.method === "POST" && u.pathname === COMMENTS) {
      const c = w!.comments[w!.comments.length - 1];
      c.user = author;
      return json(opts.postAnswer ? opts.postAnswer(c) : c, 201);
    }
    return res;
  };
  return w;
}

const exec = (w: World) => run({ env: w.env, fetch: w.fetch, out: w.out });
const writes = (w: World) => w.calls.filter((c) => c.url.origin === GH && c.method !== "GET").map((c) => `${c.method} ${c.url.pathname}`);
const warnings = (w: World) => w.stdout.filter((l) => l.startsWith("::warning"));
const firstLine = (s: string) => s.split("\n")[0];

describe("identity from the Action's own comment (GET /user -> 403)", () => {
  it("first run: POSTs, then tags the new comment's marker with the login GitHub returned", async () => {
    const w = await setup();
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual([`POST ${COMMENTS}`, "PATCH /repos/acme/widget/issues/comments/100"]);
    expect(w.comments).toHaveLength(1);
    expect(firstLine(w.comments[0].body)).toBe(TAGGED);
    expect(w.comments[0].body).toContain("4.17.20");
    expect(warnings(w)).toEqual([]);
  });

  it("second run: PATCHes that comment and POSTs nothing", async () => {
    const w = await setup();
    expect(await exec(w)).toBe(1);
    w.calls.length = 0;
    w.check = () => json(dirty("4.17.19"));
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual(["PATCH /repos/acme/widget/issues/comments/100"]);
    expect(w.comments).toHaveLength(1);
    expect(firstLine(w.comments[0].body)).toBe(TAGGED);
    expect(w.comments[0].body).toContain("4.17.19");
    expect(w.comments[0].body).not.toContain("4.17.20");
  });

  it("a foreign comment with the same marker text but another author is ignored", async () => {
    const w = await setup();
    const mallory = { id: 7, body: "<!-- tocsin-check by:mallory -->\nplanted", user: { login: "mallory", type: "User" } };
    const other = { id: 8, body: `${TAGGED}\nclaims to be the app`, user: { login: "other-app[bot]", type: "Bot" } };
    const fakeType = { id: 9, body: `${TAGGED}\nright login, wrong type`, user: { login: "tocsin-app[bot]", type: "User" } };
    const bareOtherBot = { id: 10, body: `${MARKER}\nbare marker by another bot`, user: { login: "other-app[bot]", type: "Bot" } };
    const before = [mallory, other, fakeType, bareOtherBot].map((c) => ({ ...c }));
    w.comments.push(mallory, other, fakeType, bareOtherBot);
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual([`POST ${COMMENTS}`, "PATCH /repos/acme/widget/issues/comments/100"]);
    expect(w.comments).toHaveLength(5);
    for (const b of before) expect(w.comments.find((c) => c.id === b.id)!.body).toBe(b.body);
  });

  it("a marker on line 2 of the app's own comment is not adopted", async () => {
    const w = await setup();
    const quoted = { id: 7, body: `> quoted reply\n${TAGGED}\nold`, user: APP };
    w.comments.push({ ...quoted });
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual([`POST ${COMMENTS}`, "PATCH /repos/acme/widget/issues/comments/100"]);
    expect(w.comments.find((c) => c.id === 7)!.body).toBe(quoted.body);
  });

  it("a POST answer with no author login: no tag PATCH, one warning, same exit code", async () => {
    const w = await setup({ postAnswer: (c) => ({ id: c.id, body: c.body }) });
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual([`POST ${COMMENTS}`]);
    expect(firstLine(w.comments[0].body)).toBe(MARKER);
    expect(warnings(w)).toHaveLength(1);
    expect(warnings(w)[0]).toContain("posted the PR comment");
    expect(warnings(w)[0]).toContain("no author login");
  });

  it("a POST answer with an unsafe login is never written into the marker", async () => {
    const w = await setup({ postAnswer: (c) => ({ ...c, user: { login: "x --> <b>y</b>", type: "Bot" } }) });
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual([`POST ${COMMENTS}`]);
    expect(w.comments[0].body).not.toContain("-->\n<b>");
    expect(warnings(w)).toHaveLength(1);
  });

  it("the tag PATCH answers 403: the warning says the comment was posted", async () => {
    const w = await setup({ patch: (id) => (id === 100 ? json({ message: "Forbidden" }, 403) : undefined) });
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual([`POST ${COMMENTS}`, "PATCH /repos/acme/widget/issues/comments/100"]);
    expect(w.comments).toHaveLength(1);
    expect(firstLine(w.comments[0].body)).toBe(MARKER);
    expect(warnings(w)).toHaveLength(1);
    expect(warnings(w)[0]).toContain("posted the PR comment but could not tag its owner");
    expect(warnings(w)[0]).not.toContain("could not post");
  });

  it("a known viewer (GET /user answers): the POST carries its by-marker and no tag PATCH runs", async () => {
    const w = await setup({ author: { login: "tocsin-bot", type: "User" } });
    w.viewer = { login: "tocsin-bot", type: "User" };
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual([`POST ${COMMENTS}`]);
    expect(firstLine(w.comments[0].body)).toBe("<!-- tocsin-check by:tocsin-bot -->");
    // The next run finds it through GET /user.
    w.calls.length = 0;
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual(["PATCH /repos/acme/widget/issues/comments/100"]);
  });

  it("a known viewer does not adopt its own comment whose marker names another login", async () => {
    const w = await setup({ author: { login: "tocsin-bot", type: "User" } });
    w.viewer = { login: "tocsin-bot", type: "User" };
    const other = { id: 7, body: "<!-- tocsin-check by:tocsin-app[bot] -->\nanother identity's report", user: { login: "tocsin-bot", type: "User" } };
    w.comments.push({ ...other });
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual([`POST ${COMMENTS}`]);
    expect(w.comments.find((c) => c.id === 7)!.body).toBe(other.body);
  });

  it("the default token (github-actions[bot]): one POST, no PATCH, the bare v1.0.0 marker", async () => {
    const w = await setup({ author: BOT });
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual([`POST ${COMMENTS}`]);
    expect(firstLine(w.comments[0].body)).toBe(MARKER);
    w.calls.length = 0;
    expect(await exec(w)).toBe(1);
    expect(writes(w)).toEqual(["PATCH /repos/acme/widget/issues/comments/100"]);
  });
});
