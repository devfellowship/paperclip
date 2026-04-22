#!/usr/bin/env bash
# skills/pat-broker/tests/negative-out-of-scope.sh
#
# Live end-to-end negative test. Proves an out-of-scope action returns 403
# against real GitHub when using a token minted by the broker.
#
# Required env:
#   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY
#
# Optional env:
#   PAT_BROKER_TEST_REPO  - default: devfellowship/pat-broker-probe
#                           (an empty repo the App is installed on; no human
#                            data will be touched — the test attempts to PUT
#                            a single file named `.pat-broker-probe-TIMESTAMP`)
#
# Exit 0 if 403 received (scope attenuation works), 1 otherwise. Exits 77
# (skipped) when App creds are missing.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
broker="$here/../broker.sh"
repo="${PAT_BROKER_TEST_REPO:-devfellowship/pat-broker-probe}"

if [[ -z "${GITHUB_APP_ID:-}" || -z "${GITHUB_APP_PRIVATE_KEY:-}" ]]; then
  echo "SKIP: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set. See README-setup.md."
  exit 77
fi

echo "1. Mint a read-only token (contents:read only, no write)…"
token=$(bash "$broker" --repo "$repo" --scopes contents:read --no-cache)
[[ -n "$token" ]] || { echo "FAIL: broker returned empty token" >&2; exit 1; }
echo "   minted (length=${#token})"

echo "2. Attempt contents:write action (PUT a file)…"
owner="${repo%%/*}"
name="${repo##*/}"
probe_path=".pat-broker-probe-$(date +%s)"
payload=$(jq -nc --arg msg "pat-broker negative test" --arg content "$(printf 'probe' | base64)" \
  '{message:$msg, content:$content}')
resp=$(curl -sS -w '\n%{http_code}' \
  -X PUT \
  -H "Authorization: Bearer $token" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d "$payload" \
  "https://api.github.com/repos/$owner/$name/contents/$probe_path")
code=$(tail -n1 <<<"$resp")
body=$(sed '$d' <<<"$resp")

echo "   GitHub responded HTTP $code"
echo "   body: $(jq -r '.message // .' <<<"$body" 2>/dev/null | head -c 200)"

if [[ "$code" == "403" ]]; then
  echo ""
  echo "PASS: scope attenuation works — contents:read token cannot write."
  exit 0
fi

echo ""
echo "FAIL: expected HTTP 403, got $code. Either the token was over-scoped," >&2
echo "or the repo doesn't exist / App isn't installed. Body above." >&2
exit 1
