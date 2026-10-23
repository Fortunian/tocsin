import { severitiesAtLeast } from "../feed/query";
import type { WatchlistFilter } from "./filter";

// One statement, 2 columns, the same page shape as /v1/events. Each list is
// bound as ONE JSON parameter through json_each, so 2,000 components stay far
// under D1's 100-parameter cap. Fetches limit + 1 rows to tell has_more.
export function buildWatchlistEventsQuery(f: WatchlistFilter, since: number, limit: number): { sql: string; params: unknown[] } {
  const where = ["cursor > ?"];
  const params: unknown[] = [since];
  const ecosystems = [...new Set([...f.ecosystems, ...Object.keys(f.runtimes)])];
  if (ecosystems.length) {
    where.push("ecosystem IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(ecosystems));
  }
  if (f.components.length) {
    where.push("component IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(f.components));
  }
  if (f.min_severity) {
    const labels = severitiesAtLeast(f.min_severity);
    where.push(`severity_label IN (${labels.map(() => "?").join(", ")})`);
    params.push(...labels);
  }
  if (f.exploited_only) where.push("exploited = 1");
  return { sql: `SELECT cursor, doc_json FROM advisories WHERE ${where.join(" AND ")} ORDER BY cursor LIMIT ${limit + 1}`, params };
}
