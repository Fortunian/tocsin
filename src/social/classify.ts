import { ERROR_MAX_CHARS, type XPostResult } from "./x";

// The row state an X answer leads to (TCS-106). retryable (429, 5xx) and
// billing (no credits; no post was made, nothing was charged) go back to
// pending until social.x.max_attempts; a billing error is stored with the
// prefix "billing: " so /v1/status shows it. A 2xx with no id is empty and
// terminal; any other answer and a network error are terminal failed (a
// retry after a network error could post twice). The error text comes from
// classifyXAnswer: at most 200 chars, never a header.
export type RowOutcome =
  | { status: "ok"; postedId: string; error: null; retry: false }
  | { status: "empty"; postedId: null; error: string; retry: false }
  | { status: "pending"; postedId: null; error: string; retry: true }
  | { status: "failed"; postedId: null; error: string; retry: false };

export function classifyXOutcome(o: XPostResult, attempts: number, maxAttempts: number): RowOutcome {
  if (o.kind === "ok" && o.id) return { status: "ok", postedId: o.id, error: null, retry: false };
  if (o.kind === "empty" || o.kind === "ok") return { status: "empty", postedId: null, error: o.error ?? `x answered ${o.status} with no post id`, retry: false };
  if (o.kind === "network") return { status: "failed", postedId: null, error: "network", retry: false };
  const base = o.error ?? `x answered ${o.status}`;
  const error = (o.kind === "billing" ? `billing: ${base}` : base).slice(0, ERROR_MAX_CHARS);
  if ((o.kind === "retryable" || o.kind === "billing") && attempts < maxAttempts) return { status: "pending", postedId: null, error, retry: true };
  return { status: "failed", postedId: null, error, retry: false };
}
