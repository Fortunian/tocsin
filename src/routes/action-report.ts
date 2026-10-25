import { Hono } from "hono";
import type { Env } from "../env";
import { jsonUtf8 } from "../lib/http";
import { JwksFetchError, OidcError, verifyGithubOidc } from "../lib/github-oidc";

// POST /v1/action/report (TCS-101): the GitHub Action reports its check result
// for the per-repo badge. Auth is the workflow run's GitHub OIDC token, not an
// API key. owner/repo, ref and run_id come from the token claims, so a repo can
// only report for itself and only for a run it ran. Idempotent on run_id.
// Not for browsers: CORS stays GET/HEAD/OPTIONS.
const actionReport = new Hono<{ Bindings: Env }>();

const SEVERITIES = ["low", "medium", "high", "critical"];
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ?1 owner, ?2 repo, ?3 ref, ?4 run_id. Demotes the ref's latest row, unless
// this run_id is already stored (a replay changes nothing). The NOT EXISTS has
// no reference to the outer row, so it runs once, as a seek on ux_action_reports_run.
export const DEMOTE_SQL =
  "UPDATE action_reports SET is_latest = 0 WHERE owner = ?1 AND repo = ?2 AND ref = ?3 AND is_latest = 1 AND NOT EXISTS (SELECT 1 FROM action_reports WHERE owner = ?1 AND repo = ?2 AND run_id = ?4)";
// ?1 owner, ?2 repo, ?3 ref, ?4 is_default, ?5 affected, ?6 min_severity, ?7 run_id, ?8 reported_at.
// ?4 NULL (the Action did not know the default branch, for example on a
// `schedule` run) keeps the is_default of the ref's newest row, so a run that
// demotes the default row also takes its place on the default badge. The
// subquery is one seek on idx_action_reports_ref.
export const INSERT_SQL =
  "INSERT INTO action_reports (owner, repo, ref, is_default, is_latest, affected, min_severity, run_id, reported_at) VALUES (?1, ?2, ?3, COALESCE(?4, (SELECT is_default FROM action_reports WHERE owner = ?1 AND repo = ?2 AND ref = ?3 ORDER BY id DESC LIMIT 1), 0), 1, ?5, ?6, ?7, ?8) ON CONFLICT (owner, repo, run_id) DO NOTHING";

interface ReportBody {
  repository: string;
  affected: number;
  min_severity: string;
  default_branch: string | null;
}

function parseBody(v: unknown): ReportBody | string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "body must be a JSON object";
  const o = v as Record<string, unknown>;
  if (typeof o.repository !== "string" || !REPOSITORY.test(o.repository)) return "repository must be owner/repo";
  if (typeof o.affected !== "number" || !Number.isSafeInteger(o.affected) || o.affected < 0) return "affected must be a whole number >= 0";
  if (typeof o.min_severity !== "string" || !SEVERITIES.includes(o.min_severity)) return `min_severity must be one of ${SEVERITIES.join(", ")}`;
  const db = o.default_branch;
  if (db !== undefined && db !== null && (typeof db !== "string" || db === "" || db.length > 255)) return "default_branch must be a branch name";
  return { repository: o.repository, affected: o.affected, min_severity: o.min_severity, default_branch: typeof db === "string" ? db : null };
}

actionReport.post("/", async (c) => {
  const m = /^Bearer\s+(\S+)$/.exec(c.req.header("Authorization") ?? "");
  if (!m) return jsonUtf8(c, { error: "missing token" }, 401);

  let claims;
  try {
    claims = await verifyGithubOidc(c.env, m[1], new URL(c.req.url).host, new Date());
  } catch (err) {
    if (err instanceof OidcError) return jsonUtf8(c, { error: "invalid token", reason: err.reason }, 401);
    if (err instanceof JwksFetchError) {
      console.error(JSON.stringify({ lane: "action-report", step: "jwks", err: `${err.name}: ${err.message}` }));
      return jsonUtf8(c, { error: "oidc keys unavailable" }, 503);
    }
    throw err;
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return jsonUtf8(c, { error: "body must be JSON" }, 400);
  }
  const body = parseBody(raw);
  if (typeof body === "string") return jsonUtf8(c, { error: body }, 400);

  const repository = claims.repository.toLowerCase();
  if (body.repository.toLowerCase() !== repository) return jsonUtf8(c, { error: "token is for another repository" }, 403);
  if (claims.repository_visibility !== "public") return jsonUtf8(c, { error: "badge reports are for public repositories" }, 403);

  const [owner, repo] = repository.split("/");
  // null: the Action did not send the default branch; INSERT_SQL keeps the ref's last known value.
  const isDefault = body.default_branch === null ? null : claims.ref === `refs/heads/${body.default_branch}` ? 1 : 0;
  // One batch is one transaction: a ref never has 0 or 2 latest rows after it commits.
  const [, inserted] = await c.env.DB.batch([
    c.env.DB.prepare(DEMOTE_SQL).bind(owner, repo, claims.ref, claims.run_id),
    c.env.DB.prepare(INSERT_SQL).bind(owner, repo, claims.ref, isDefault, body.affected, body.min_severity, claims.run_id, new Date().toISOString()),
  ]);
  return jsonUtf8(c, { recorded: inserted.meta.changes === 1 });
});

export default actionReport;
