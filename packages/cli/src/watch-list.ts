// `tocsin watch --upload` and the `watch` status line: the key's default watch
// list (the list named exactly "default") and its dependency set.
import { Api, describeFailure, type ApiResult } from "./api.js";
import type { Io } from "./io.js";
import { findLockfiles } from "./lockfiles.js";

export const DEFAULT_LIST_NAME = "default";

/** A failed or malformed API answer. The caller prints describeFailure(result). */
export class ApiFailure extends Error {
  constructor(readonly result: ApiResult) {
    super(describeFailure(result));
  }
}

interface ListItem {
  id: string;
  name: string;
}

interface UploadAnswer {
  dependencies: number;
  affected: unknown[];
}

const isObject = (b: unknown): b is Record<string, unknown> => typeof b === "object" && b !== null;

function isListItem(b: unknown): b is ListItem {
  return isObject(b) && typeof b.id === "string" && typeof b.name === "string";
}

function isUploadAnswer(b: unknown): b is UploadAnswer {
  return isObject(b) && typeof b.dependencies === "number" && Array.isArray(b.affected);
}

/** The ok body of a call. A failed or malformed answer throws ApiFailure. */
function okBody<T>(r: ApiResult, valid: (b: unknown) => b is T): T {
  if (!r.ok || !valid(r.body)) throw new ApiFailure(r);
  return r.body;
}

/**
 * The key's list named exactly "default", or null when the key has none.
 * A failed read throws: it is never read as "no list" (that would create a second one).
 */
export async function findDefaultList(api: Api): Promise<ListItem | null> {
  const body = okBody(await api.listWatchlists(), (b): b is { watchlists: unknown[] } => isObject(b) && Array.isArray(b.watchlists));
  return body.watchlists.filter(isListItem).find((l) => l.name === DEFAULT_LIST_NAME) ?? null;
}

/** `watching N dependencies, last delivery at <ISO or never>` for the default list. Throws ApiFailure. */
export async function statusLine(api: Api): Promise<string> {
  const list = await findDefaultList(api);
  if (!list) return "watching 0 dependencies, last delivery at never";
  const body = okBody(
    await api.getWatchlist(list.id),
    (b): b is { dependencies: number; last_delivery_at: string | null } =>
      isObject(b) && typeof b.dependencies === "number" && (b.last_delivery_at === null || typeof b.last_delivery_at === "string"),
  );
  return `watching ${body.dependencies} dependencies, last delivery at ${body.last_delivery_at ?? "never"}`;
}

// One stderr line. A 413 names the plan limit from the answer body.
function failureLine(f: ApiFailure): string {
  const b = f.result.body;
  const limit = f.result.status === 413 && isObject(b) && typeof b.max_watch_dependencies === "number" ? ` (limit ${b.max_watch_dependencies} dependencies)` : "";
  return `watch --upload failed: ${f.message}${limit}`;
}

/** `watch --upload`: exit 0 uploaded, 2 no key or no lockfile, 3 the API call failed. It does not poll. */
export async function runUpload(io: Io): Promise<number> {
  if (!io.env.TOCSIN_API_KEY) {
    io.err("tocsin watch: --upload needs TOCSIN_API_KEY (a watch list belongs to a key)");
    return 2;
  }
  const lockfiles = await findLockfiles(io.cwd);
  if (lockfiles.length === 0) {
    io.err(`tocsin watch: no lockfile in ${io.cwd}; run in a project directory`);
    return 2;
  }

  const api = new Api(io);
  try {
    // No delivery field: the server makes a poll list. The user sets a webhook with PATCH.
    const list = (await findDefaultList(api)) ?? okBody(await api.createWatchlist(DEFAULT_LIST_NAME), isListItem);
    const answer = okBody(await api.uploadLockfiles(list.id, lockfiles), isUploadAnswer);
    io.out(`uploaded ${answer.dependencies} dependencies to watch list ${DEFAULT_LIST_NAME} (${list.id}), ${answer.affected.length} affected now`);
    io.out(await statusLine(api));
    return 0;
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    io.err(failureLine(e));
    return 3;
  }
}
