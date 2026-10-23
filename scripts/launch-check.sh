#!/usr/bin/env bash
# launch-check.sh: the acceptance test of the Tocsin launch.
#
# It reads a running Tocsin (default https://tocsin.sh) and runs five checks:
#   node-cve     GET /v1/events/cve/CVE-2026-111497 lists fixed version 24.22.1
#   php-cve      GET /v1/events/cve/CVE-2026-109618 lists fixed version 8.4.27
#   check-node   GET /v1/check?node=24.22.0 has an affected item for CVE-2026-111497 with fixed_in 24.22.1
#   status       GET /v1/status lists sources; none has last_error set or last_ok_at older
#                than MAX_AGE_HOURS (a source with no first run yet prints a WARN line)
#   cli-connect  `$TOCSIN_CLI connect --dry-run` prints the MCP block for MCP_URL
#
# With COVERAGE_CHECK=1 (set after the OSV backfill, docs/BACKFILL.md) it runs three more:
#   cov-lodash   POST /v1/check npm lodash 4.17.15 lists CVE-2020-8203 and CVE-2021-23337
#   cov-django   POST /v1/check PyPI django 3.2.0 lists at least COV_DJANGO_MIN affected items
#   cov-count    for each OSV ecosystem in /v1/status coverage, the backfill records are at
#                least COV_MIN_PCT percent of the non-MAL- ids in OSV's <eco>/modified_id.csv
#
# With KEYS_CHECK=1 (a one-time operator run after the mail setup, docs/OPERATING.md) it runs one more:
#   keys-signup  POST /v1/keys for KEYS_CHECK_EMAIL answers 202 with status "sent" (it sends one real mail)
#
# It prints `ok <check>` or `FAIL <check>: <reason>` per check (plus `WARN <check>: ...`
# lines that do not fail a check), then
# `launch-check: <n> of <total> passed` (total 5, plus 3 with COVERAGE_CHECK=1, plus 1 with KEYS_CHECK=1).
# Exit 0 only when all of them pass, else exit 1.
# Without KEYS_CHECK it only reads: GET requests, POST /v1/check, and a dry run of the CLI with a throwaway HOME.
#
# Env (all optional):
#   BASE_URL       the Tocsin host               default https://tocsin.sh
#   TOCSIN_CLI     the CLI command               default npx --yes tocsin@latest
#   MCP_URL        the MCP URL the block names   default https://mcp.tocsin.sh/mcp
#   MAX_AGE_HOURS  max age of last_ok_at         default 24
#   COVERAGE_CHECK 1 runs the cov- checks        default unset (off)
#   COV_MIN_PCT    cov-count threshold, percent  default 90
#   COV_DJANGO_MIN cov-django minimum count      default 10
#   OSV_BASE       the OSV export bucket         default https://osv-vulnerabilities.storage.googleapis.com
#   KEYS_CHECK     1 runs keys-signup            default unset (off)
#   KEYS_CHECK_EMAIL  the inbox keys-signup mails  no default; required when KEYS_CHECK=1
#
#   bash scripts/launch-check.sh
#   BASE_URL=http://localhost:8787 TOCSIN_CLI="node packages/cli/bin/tocsin.js" bash scripts/launch-check.sh
#   KEYS_CHECK=1 KEYS_CHECK_EMAIL=you@example.com bash scripts/launch-check.sh
set -uo pipefail

BASE_URL="${BASE_URL:-https://tocsin.sh}"
BASE_URL="${BASE_URL%/}"
TOCSIN_CLI="${TOCSIN_CLI:-npx --yes tocsin@latest}"
MCP_URL="${MCP_URL:-https://mcp.tocsin.sh/mcp}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-24}"
COVERAGE_CHECK="${COVERAGE_CHECK:-}"
COV_MIN_PCT="${COV_MIN_PCT:-90}"
COV_DJANGO_MIN="${COV_DJANGO_MIN:-10}"
OSV_BASE="${OSV_BASE:-https://osv-vulnerabilities.storage.googleapis.com}"
OSV_BASE="${OSV_BASE%/}"
KEYS_CHECK="${KEYS_CHECK:-}"
KEYS_CHECK_EMAIL="${KEYS_CHECK_EMAIL:-}"
TOTAL=5
if [[ "$COVERAGE_CHECK" == "1" ]]; then TOTAL=$((TOTAL + 3)); fi
if [[ "$KEYS_CHECK" == "1" ]]; then TOTAL=$((TOTAL + 1)); fi

for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL preflight: $tool not found"
    exit 1
  fi
done
for knob in MAX_AGE_HOURS COV_MIN_PCT COV_DJANGO_MIN; do
  if ! [[ "${!knob}" =~ ^[0-9]+$ ]]; then
    echo "FAIL preflight: $knob must be a whole number, got '${!knob}'"
    exit 1
  fi
done
if [[ "$KEYS_CHECK" == "1" && -z "$KEYS_CHECK_EMAIL" ]]; then
  echo "FAIL preflight: KEYS_CHECK_EMAIL must be set when KEYS_CHECK=1"
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

# status: every enabled source is ok. A source FAILs when its last run left an
# error (last_error set), or when its last_ok_at is older than MAX_AGE_HOURS.
# A source with no last_ok_at and no error has not had its first cron yet (a
# source added in the last deploy). /v1/status carries no created time, so its
# age is not known: it gets a WARN line, not a FAIL. D1 stores toISOString()
# values with milliseconds; fromdateiso8601 refuses fractions, so they are cut first.
if ! get "/v1/status"; then
  fail status "$REASON"
else
  verdict="$(jq -c --argjson now "$(date -u +%s)" --argjson max "$((MAX_AGE_HOURS * 3600))" '
    (.sources // []) as $s
    | if ($s | length) == 0 then {fail: ["no sources listed"], warn: []}
      else ($s | map(
          if .last_error != null then {fail: "\(.id) (last error: \(.last_error))"}
          elif .last_ok_at == null then {warn: "\(.id) has not succeeded yet (no first cron run)"}
          else (.last_ok_at | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch null) as $t
            | if $t == null then {fail: "\(.id) (unreadable last_ok_at \(.last_ok_at))"}
              elif ($now - $t) > $max then {fail: "\(.id) (last ok \(.last_ok_at))"}
              else {} end
          end)) as $v
        | {fail: [$v[] | .fail // empty], warn: [$v[] | .warn // empty]}
      end
  ' "$BODY_FILE" 2>&1)"
  if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$verdict"; then
    fail status "cannot read /v1/status sources: $verdict"
  else
    jq -r '.warn[] | "WARN status: \(.)"' <<<"$verdict"
    failed="$(jq -r '.fail | join(", ")' <<<"$verdict")"
    if [[ -z "$failed" ]]; then
      ok status
    else
      fail status "not ok (max age ${MAX_AGE_HOURS} h): $failed"
    fi
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

# post_check <path> <json>: POST JSON; on success the body is in $BODY_FILE.
post_check() {
  local code
  if ! code="$(curl -sS --max-time 20 -o "$BODY_FILE" -w '%{http_code}' -H 'Content-Type: application/json' --data "$2" "$BASE_URL$1" 2>"$WORK/curl.err")"; then
    REASON="POST $1: curl error: $(head -1 "$WORK/curl.err")"
    return 1
  fi
  if [[ "$code" != "200" ]]; then
    REASON="POST $1: HTTP $code"
    return 1
  fi
  if ! jq -e . "$BODY_FILE" >/dev/null 2>&1; then
    REASON="POST $1: body is not JSON"
    return 1
  fi
  return 0
}

if [[ "$COVERAGE_CHECK" == "1" ]]; then
  # cov-lodash: two well-known lodash CVEs for a version below both fixes.
  if ! post_check /v1/check '{"dependencies":[{"ecosystem":"npm","name":"lodash","version":"4.17.15"}]}'; then
    fail cov-lodash "$REASON"
  else
    missing="$(jq -r '[.affected[]?.cve_ids[]?] as $c | ["CVE-2020-8203", "CVE-2021-23337"] - $c | join(", ")' "$BODY_FILE")"
    if [[ -z "$missing" ]]; then ok cov-lodash; else fail cov-lodash "npm lodash 4.17.15: no affected item for $missing"; fi
  fi

  # cov-django: an old django release has many advisories.
  if ! post_check /v1/check '{"dependencies":[{"ecosystem":"PyPI","name":"django","version":"3.2.0"}]}'; then
    fail cov-django "$REASON"
  else
    n="$(jq '.affected | length' "$BODY_FILE")"
    if [[ "$n" -ge "$COV_DJANGO_MIN" ]]; then ok cov-django; else fail cov-django "PyPI django 3.2.0: $n affected, want at least $COV_DJANGO_MIN"; fi
  fi

  # cov-count: backfill records per OSV ecosystem against OSV's own id list.
  if ! get "/v1/status"; then
    fail cov-count "$REASON"
  else
    jq -r '.coverage[]? | select(.imported != null) | "\(.ecosystem)\t\(.imported)"' "$BODY_FILE" >"$WORK/cov.tsv"
    short=()
    if [[ ! -s "$WORK/cov.tsv" ]]; then short+=("no OSV ecosystem in /v1/status coverage"); fi
    while IFS=$'\t' read -r eco have; do
      csv_url="$OSV_BASE/$(jq -rn --arg e "$eco" '$e | @uri')/modified_id.csv"
      if ! curl -sS --max-time 120 -f -o "$WORK/ids.csv" "$csv_url" 2>"$WORK/curl.err"; then
        short+=("$eco (cannot read $csv_url: $(head -1 "$WORK/curl.err"))")
        continue
      fi
      want="$(cut -d, -f2 "$WORK/ids.csv" | grep -v '^MAL-' | grep -c . || true)"
      if (( have * 100 < want * COV_MIN_PCT )); then short+=("$eco $have of $want"); fi
    done <"$WORK/cov.tsv"
    if [[ ${#short[@]} -eq 0 ]]; then
      ok cov-count
    else
      joined="$(printf '%s; ' "${short[@]}")"
      fail cov-count "under ${COV_MIN_PCT}% of the OSV ids: ${joined%; }"
    fi
  fi
fi

# keys-signup: the mail setup works end to end. 202 means the provider took the
# mail; 503 means mail is not configured (no secret) or the daily cap is hit.
if [[ "$KEYS_CHECK" == "1" ]]; then
  body="$(jq -cn --arg e "$KEYS_CHECK_EMAIL" '{email: $e}')"
  if ! code="$(curl -sS --max-time 20 -o "$BODY_FILE" -w '%{http_code}' -H 'Content-Type: application/json' --data "$body" "$BASE_URL/v1/keys" 2>"$WORK/curl.err")"; then
    fail keys-signup "POST /v1/keys: curl error: $(head -1 "$WORK/curl.err")"
  elif [[ "$code" == "503" ]]; then
    fail keys-signup "POST /v1/keys: HTTP 503 (mail not configured or daily cap hit, docs/OPERATING.md)"
  elif [[ "$code" != "202" ]]; then
    fail keys-signup "POST /v1/keys: HTTP $code"
  elif jq -e '.status == "sent"' "$BODY_FILE" >/dev/null 2>&1; then
    ok keys-signup
  else
    fail keys-signup "POST /v1/keys: HTTP 202 but the body has no status \"sent\": $(head -c 200 "$BODY_FILE")"
  fi
fi

echo "launch-check: $PASSED of $TOTAL passed"
[[ "$PASSED" -eq "$TOTAL" ]]
