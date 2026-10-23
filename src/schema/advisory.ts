// Advisory schema v1. The source of truth is schema/advisory.v1.json; the
// validator is compiled from it by scripts/gen-advisory-validator.mjs.
import validate from "./advisory.validate.generated.js";

export type SeverityLabel = "critical" | "high" | "medium" | "low" | "unknown";

export interface AffectedRange {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}

export interface AdvisorySource {
  source: string;
  source_id: string;
  url: string;
}

export interface Advisory {
  id: string;
  cve_ids: string[];
  ghsa_id?: string;
  ecosystem: string;
  // The full OSV ecosystem string when it has a suffix (Packagist:https://packages.drupal.org/8).
  ecosystem_qualifier?: string;
  component: string;
  affected: AffectedRange[];
  fixed_versions: string[];
  severity: { score?: number; label: SeverityLabel };
  exploited: boolean;
  epss?: number;
  published_at: string;
  modified_at: string;
  summary: string;
  action: string;
  references: string[];
  sources: AdvisorySource[];
}

export type ValidateResult = { ok: true; value: Advisory } | { ok: false; errors: string[] };

export function validateAdvisory(x: unknown): ValidateResult {
  if (validate(x)) return { ok: true, value: x as Advisory };
  const errors = (validate.errors ?? []).map((e) => {
    const detail = e.params && "additionalProperty" in e.params ? ` (${String(e.params.additionalProperty)})` : "";
    return `${e.instancePath || "/"} ${e.message ?? e.keyword}${detail}`;
  });
  return { ok: false, errors };
}
