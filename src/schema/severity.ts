// Severity label from a CVSS base score: the CVSS qualitative bands
// (spec section 5). A score of 0 is "None" in CVSS; the advisory schema has
// no "none", so it maps to unknown.
import type { SeverityLabel } from "./advisory";

export function labelFromScore(score: number): SeverityLabel {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0) return "low";
  return "unknown";
}
