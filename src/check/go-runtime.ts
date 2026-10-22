// Go toolchain advisories as a runtime. OSV files Go toolchain vulnerabilities
// under ecosystem `Go` with package `stdlib`, `toolchain` or `cmd/<tool>`. The
// stored row stays a `Go` row for module matching; for a `go` runtime
// dependency the matcher also reads it through this view (ecosystem `go`,
// component `go`). The view is never written: one advisory, two match paths.
import type { Advisory } from "../schema/advisory";
import type { Dependency } from "./parsers";

export const GO_RUNTIME = "go";

/** True for an OSV `Go` advisory on the Go toolchain itself, not on a module. */
export function isGoToolchainAdvisory(a: Pick<Advisory, "ecosystem" | "component">): boolean {
  if (a.ecosystem !== "Go") return false;
  return a.component === "stdlib" || a.component === "toolchain" || a.component.startsWith("cmd/");
}

/** The advisory as the `go` runtime sees it. Ranges, fixes and text are unchanged. */
export function goRuntimeView(a: Advisory): Advisory {
  return { ...a, ecosystem: GO_RUNTIME, component: GO_RUNTIME };
}

/** True when the check has a `go` runtime dependency, so the toolchain rows must be read. */
export function needsGoToolchainRows(deps: Dependency[]): boolean {
  return deps.some((d) => d.ecosystem === GO_RUNTIME && d.name === GO_RUNTIME);
}
