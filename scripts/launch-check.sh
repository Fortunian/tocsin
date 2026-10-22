#!/usr/bin/env bash
# launch-check.sh: the acceptance test of the Tocsin launch.
#
# It reads a running Tocsin (default https://tocsin.sh) and runs five checks:
#   node-cve     GET /v1/events/cve/CVE-2026-111497 lists fixed version 24.22.1
#   php-cve      GET /v1/events/cve/CVE-2026-109618 lists fixed version 8.4.27
#   check-node   GET /v1/check?node=24.22.0 has an affected item for CVE-2026-111497 with fixed_in 24.22.1
#   status       GET /v1/status lists sources, and each one has last_ok_at within MAX_AGE_HOURS
#   cli-connect  `$TOCSIN_CLI connect --dry-run` prints the MCP block for MCP_URL
#
# It prints `ok <check>` or `FAIL <check>: <reason>` per check, then
# `launch-check: <n> of 5 passed`. Exit 0 only when all five pass, else exit 1.
# It only reads: GET requests, and a dry run of the CLI with a throwaway HOME.
#
# Env (all optional):
#   BASE_URL       the Tocsin host               default https://tocsin.sh
#   TOCSIN_CLI     the CLI command               default npx --yes tocsin@latest
#   MCP_URL        the MCP URL the block names   default https://mcp.tocsin.sh/mcp
#   MAX_AGE_HOURS  max age of last_ok_at         default 24
#
#   bash scripts/launch-check.sh
#   BASE_URL=http://localhost:8787 TOCSIN_CLI="node packages/cli/bin/tocsin.js" bash scripts/launch-check.sh
set -uo pipefail

BASE_URL="${BASE_URL:-https://tocsin.sh}"
BASE_URL="${BASE_URL%/}"
TOCSIN_CLI="${TOCSIN_CLI:-npx --yes tocsin@latest}"
MCP_URL="${MCP_URL:-https://mcp.tocsin.sh/mcp}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-24}"

for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL preflight: $tool not found"
    exit 1
  fi
done
if ! [[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]]; then
  echo "FAIL preflight: MAX_AGE_HOURS must be a whole number, got '$MAX_AGE_HOURS'"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BODY_FILE="$WORK/body"
PASSED=0
REASON=""

ok() {
  echo "ok $1"
  PASSED=$((PASSED + 1))
}
fail() { echo "FAIL $1: $2"; }

# get <path>: on success the JSON body is in $BODY_FILE and it returns 0.
# On failure it sets REASON and returns 1.
get() {
  local code
  if ! code="$(curl -sS --max-time 20 -o "$BODY_FILE" -w '%{http_code}' "$BASE_URL$1" 2>"$WORK/curl.err")"; then
    REASON="GET $1: curl error: $(head -1 "$WORK/curl.err")"
    return 1
  fi
  if [[ "$code" != "200" ]]; then
    REASON="GET $1: HTTP $code"
    return 1
  fi
  if ! jq -e . "$BODY_FILE" >/dev/null 2>&1; then
    REASON="GET $1: body is not JSON"
    return 1
  fi
  return 0
}

# fixed_check <check> <cve> <version>: the advisory lists <version> in fixed_versions.
fixed_check() {
  if ! get "/v1/events/cve/$2"; then
    fail "$1" "$REASON"
    return
  fi
  if jq -e --arg v "$3" '(.fixed_versions // []) | index($v) != null' "$BODY_FILE" >/dev/null; then
    ok "$1"
  else
    fail "$1" "$2 fixed_versions $(jq -c '.fixed_versions' "$BODY_FILE") has no $3"
  fi
}

fixed_check node-cve CVE-2026-111497 24.22.1
fixed_check php-cve CVE-2026-109618 8.4.27

# check-node: node 24.22.0 is affected, and CVE-2026-111497 says to upgrade to 24.22.1.
if ! get "/v1/check?node=24.22.0"; then
  fail check-node "$REASON"
elif jq -e '
    (.affected | type == "array" and length >= 1)
    and any(.affected[]; ((.cve_ids // []) | index("CVE-2026-111497") != null) and .fixed_in == "24.22.1")
  ' "$BODY_FILE" >/dev/null; then
  ok check-node
else
  fail check-node "node 24.22.0: no affected item for CVE-2026-111497 with fixed_in 24.22.1 ($(jq -c '[.affected[]? | {cve_ids, fixed_in}]' "$BODY_FILE"))"
fi

# status: every enabled source succeeded within MAX_AGE_HOURS. D1 stores
# toISOString() values with milliseconds; fromdateiso8601 refuses fractions,
# so they are cut first.
if ! get "/v1/status"; then
  fail status "$REASON"
else
  stale="$(jq -r --argjson now "$(date -u +%s)" --argjson max "$((MAX_AGE_HOURS * 3600))" '
    (.sources // [])
    | if length == 0 then "no sources listed"
      else map(
          if .last_ok_at == null then "\(.id) (never ok)"
          else (.last_ok_at | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch null) as $t
            | if $t == null then "\(.id) (unreadable last_ok_at \(.last_ok_at))"
              elif ($now - $t) > $max then "\(.id) (last ok \(.last_ok_at))"
              else empty end
          end)
        | join(", ")
      end
  ' "$BODY_FILE" 2>&1)"
  if [[ -z "$stale" ]]; then
    ok status
  else
    fail status "not ok within ${MAX_AGE_HOURS} h: $stale"
  fi
fi

# cli-connect: a dry run with a throwaway HOME, so no real agent config is read or written.
# The exit code is only reported: a HOME with no agent tool still prints the generic block.
mkdir -p "$WORK/home"
# shellcheck disable=SC2086 # TOCSIN_CLI is a command line, split on purpose.
cli_out="$(HOME="$WORK/home" USERPROFILE="$WORK/home" timeout 120 $TOCSIN_CLI connect --dry-run 2>&1)"
cli_rc=$?
if [[ "$cli_out" == *"$MCP_URL"* ]] && { [[ "$cli_out" == *'"mcpServers"'* ]] || [[ "$cli_out" == *"[mcp_servers.tocsin]"* ]]; }; then
  ok cli-connect
else
  fail cli-connect "'$TOCSIN_CLI connect --dry-run' (exit $cli_rc) printed no MCP block for $MCP_URL: $(echo "$cli_out" | head -3 | tr '\n' ' ')"
fi

echo "launch-check: $PASSED of 5 passed"
[[ "$PASSED" -eq 5 ]]
