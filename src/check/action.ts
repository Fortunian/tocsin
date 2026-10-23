// The action of one /v1/check item. An OSV advisory with several fixed lines
// names the fix of the range the dependency matched (TCS-75). Every other
// advisory keeps its stored action: runtime sources write their own per-line
// text with notes a generic sentence would drop.
import type { Advisory } from "../schema/advisory";

// The schema limit of `action` (schema/advisory.v1.json, max 200 chars).
const MAX_ACTION = 200;

export function matchAction(a: Advisory, fixed_in: string | undefined): string {
  if (a.sources[0]?.source !== "osv" || fixed_in === undefined) return a.action;
  const fixes = new Set([...a.affected.flatMap((r) => (r.fixed === undefined ? [] : [r.fixed])), ...a.fixed_versions]);
  if (fixes.size < 2) return a.action;
  return `Upgrade ${a.component} to ${fixed_in} or later.`.slice(0, MAX_ACTION).trim();
}
