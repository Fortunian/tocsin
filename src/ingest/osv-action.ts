// The action sentence of one OSV package, from its fixed versions. Several
// fixed lines are named one by one, as the Node ingester does: "Upgrade undici
// to 6.28.1 (6.x), 7.29.1 (7.x) or 8.10.2 (8.x) or later." (TCS-75).

export const NO_FIX = "No fix published. Pin and monitor.";

// The schema limit of `action` (schema/advisory.v1.json, max 200 chars).
const MAX_ACTION = 200;

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_ACTION).trim();
}

// The line of each version at `depth` segments ("6.28.1" -> "6"), or undefined
// when a needed segment is not all digits or two versions share a line.
function lineLabels(versions: string[], depth: number): string[] | undefined {
  const labels: string[] = [];
  for (const v of versions) {
    const parts = v.split(".").slice(0, depth);
    if (parts.length < depth || !parts.every((p) => /^\d+$/.test(p))) return undefined;
    labels.push(parts.join("."));
  }
  return new Set(labels).size === labels.length ? labels : undefined;
}

export function osvAction(component: string, fixed: string[], compare: (a: string, b: string) => number): string {
  const versions = [...new Set(fixed)].sort(compare);
  if (versions.length === 0) return NO_FIX;
  if (versions.length === 1) return oneLine(`Upgrade ${component} to ${versions[0]} or later.`);
  const labels = lineLabels(versions, 1) ?? lineLabels(versions, 2);
  if (labels) {
    const parts = versions.map((v, i) => `${v} (${labels[i]}.x)`);
    const text = `Upgrade ${component} to ${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]} or later.`;
    if (text.length <= MAX_ACTION) return text;
  }
  return oneLine(`Upgrade ${component} to the fixed version for your line (see fixed_versions).`);
}
