#!/usr/bin/env bash
# Validates the Claude Code plugin (plugins/tocsin) and the in-repo marketplace
# (.claude-plugin/marketplace.json) with the claude CLI, in strict mode.
# A runner with no claude CLI skips with a reason; the JSON shape checks still
# run in npm test (tests/plugin/plugin-manifest.tcs-100.test.ts). A failed
# validation exits non-zero and is never turned into a skip.
#
#   bash scripts/validate-plugin.sh               validate this checkout
#   bash scripts/validate-plugin.sh --root <dir>  validate another checkout (tests)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" = "--root" ]; then
  root="${2:?--root needs a directory}"
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "validate-plugin: skip: the claude CLI is not on this runner (marketplace and plugin JSON checks run in npm test)"
  exit 0
fi

cd "$root"
rc=0
for target in ./plugins/tocsin .; do
  echo "\$ claude plugin validate --strict $target"
  claude plugin validate --strict "$target" || rc=$?
done
if [ "$rc" -ne 0 ]; then
  echo "validate-plugin: FAIL (rc=$rc)"
fi
exit "$rc"
