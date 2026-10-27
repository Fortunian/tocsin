import type { XPostOutcome } from "./x";

// The row state an X answer leads to (TCS-106). 429 and 5xx retry until
// social.x.max_attempts; a 2xx with no id is empty and terminal; any other
// 4xx and a network error are terminal failed (a retry after a network error
// could post twice). error is at most 200 chars and never holds a header.
export const ERROR_MAX_CHARS = 200; // the ticket's cap on stored error text, not a tunable limit

export type RowOutcome =
  | { status: "ok"; postedId: string; error: null; retry: false }
  | { status: "empty"; postedId: null; error: string; retry: false }
  | { status: "pending"; postedId: null; error: string; retry: true }
  | { status: "failed"; postedId: null; error: string; retry: false };

export function classifyXOutcome(o: XPostOutcome, attempts: number, maxAttempts: number): RowOutcome {
  if (o.kind === "ok") return { status: "ok", postedId: o.id, error: null, retry: false };
  if (o.kind === "empty") return { status: "empty", postedId: null, error: `x answered ${o.status} with no post id`, retry: false };
  if (o.kind === "network") return { status: "failed", postedId: null, error: "network", retry: false };
  const error = `x answered ${o.status}: ${o.body}`.slice(0, ERROR_MAX_CHARS);
  if ((o.status === 429 || o.status >= 500) && attempts < maxAttempts) return { status: "pending", postedId: null, error, retry: true };
  return { status: "failed", postedId: null, error, retry: false };
}
