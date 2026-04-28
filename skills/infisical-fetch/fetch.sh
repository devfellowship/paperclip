#!/usr/bin/env bash
# infisical-fetch/fetch.sh
#
# Authenticates with Infisical via Universal Auth and outputs secrets
# from /agents/{INFISICAL_AGENT_NAME}/ and /shared/ as dotenv.
#
# Usage: eval $(bash skills/infisical-fetch/fetch.sh)
#
# Required env:
#   INFISICAL_CLIENT_ID      — Universal Auth client ID
#   INFISICAL_CLIENT_SECRET  — Universal Auth client secret
#   INFISICAL_AGENT_NAME     — agent path name (e.g. "dev-dfl" for dev-dfl-architect)
#
# Optional env:
#   INFISICAL_API_URL        — defaults to https://infisical.devfellowship.com
#   INFISICAL_PROJECT_ID     — defaults to personal-vaults-tainan project
#   INFISICAL_ENV            — defaults to prod

set -euo pipefail

INFISICAL_API_URL="${INFISICAL_API_URL:-https://infisical.devfellowship.com}"
INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID:-f9572f70-c99d-4a44-8686-e9e83ff5a8fe}"
INFISICAL_ENV="${INFISICAL_ENV:-prod}"

# Validate required vars
if [[ -z "${INFISICAL_CLIENT_ID:-}" ]]; then
  echo "# infisical-fetch: INFISICAL_CLIENT_ID not set — skipping" >&2
  exit 0
fi
if [[ -z "${INFISICAL_CLIENT_SECRET:-}" ]]; then
  echo "# infisical-fetch: INFISICAL_CLIENT_SECRET not set — skipping" >&2
  exit 0
fi
if [[ -z "${INFISICAL_AGENT_NAME:-}" ]]; then
  echo "# infisical-fetch: INFISICAL_AGENT_NAME not set — skipping agent path" >&2
fi

# Step 1: Authenticate via Universal Auth
AUTH_RESPONSE=$(curl -sf \
  -X POST "${INFISICAL_API_URL}/api/v1/auth/universal-auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"clientId\":\"${INFISICAL_CLIENT_ID}\",\"clientSecret\":\"${INFISICAL_CLIENT_SECRET}\"}" \
  2>/dev/null) || {
  echo "# infisical-fetch: auth failed — check CLIENT_ID/SECRET and Infisical connectivity" >&2
  exit 0
}

ACCESS_TOKEN=$(echo "$AUTH_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))" 2>/dev/null)

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "# infisical-fetch: no accessToken in auth response" >&2
  exit 0
fi

# Common infisical export flags
INFISICAL_FLAGS=(
  --domain="${INFISICAL_API_URL}"
  --token="${ACCESS_TOKEN}"
  --projectId="${INFISICAL_PROJECT_ID}"
  --env="${INFISICAL_ENV}"
  --format=dotenv
  --silent
)

# Step 2: Export agent-specific secrets (if INFISICAL_AGENT_NAME is set)
if [[ -n "${INFISICAL_AGENT_NAME:-}" ]]; then
  infisical export "${INFISICAL_FLAGS[@]}" --path="/agents/${INFISICAL_AGENT_NAME}/" 2>/dev/null || true
fi

# Step 3: Export shared secrets
infisical export "${INFISICAL_FLAGS[@]}" --path="/shared/" 2>/dev/null || true
