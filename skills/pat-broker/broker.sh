#!/usr/bin/env bash
# skills/pat-broker/broker.sh
#
# Mint a short-lived, scoped GitHub installation token.
# See skills/pat-broker/SKILL.md for usage.

set -euo pipefail

readonly PROG="pat-broker"
readonly GITHUB_API="${GITHUB_API:-https://api.github.com}"
readonly CACHE_DIR="${PAT_BROKER_CACHE_DIR:-${HOME:-/tmp}/.cache/pat-broker}"
readonly AUDIT_LOG="${PAT_BROKER_AUDIT_LOG:-/var/log/paperclip/pat-broker-audit.jsonl}"
readonly AGENT_ID="${PAT_BROKER_AGENT_ID:-${PAPERCLIP_AGENT_ID:-${OTEL_SERVICE_NAME:-unknown}}}"

REPO=""
SCOPES=""
TTL=600
JSON_OUT=0
DRY_RUN=0
NO_CACHE=0

die() { echo "${PROG}: $*" >&2; exit 1; }
log() { echo "${PROG}: $*" >&2; }

usage() {
  sed -n '1,4p;/^REPO=""/,$d' "$0" | grep -E '^#( |$)' | sed 's/^# \{0,1\}//' >&2
  echo "" >&2
  echo "Usage: $PROG --repo OWNER/NAME --scopes P:ACCESS,... [--ttl N] [--json] [--no-cache] [--dry-run]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --scopes) SCOPES="$2"; shift 2 ;;
    --ttl) TTL="$2"; shift 2 ;;
    --json) JSON_OUT=1; shift ;;
    --no-cache) NO_CACHE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown flag: $1" ;;
  esac
done

[[ -n "$REPO" ]] || die "--repo OWNER/NAME is required"
[[ -n "$SCOPES" ]] || die "--scopes P:ACCESS,... is required"
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "--repo must be OWNER/NAME, got: $REPO"

command -v openssl >/dev/null || die "openssl not found"
command -v jq >/dev/null      || die "jq not found"
command -v curl >/dev/null    || die "curl not found"

scopes_to_permissions_json() {
  # "contents:write,pull_requests:read" -> {"contents":"write","pull_requests":"read"}
  local csv="$1"
  local out="{}"
  local pair key val
  IFS=',' read -ra pairs <<<"$csv"
  for pair in "${pairs[@]}"; do
    pair="${pair// /}"
    [[ -z "$pair" ]] && continue
    [[ "$pair" == *:* ]] || die "scope must be permission:level, got: $pair"
    key="${pair%%:*}"
    val="${pair##*:}"
    case "$val" in read|write|admin) ;; *) die "scope level must be read|write|admin, got: $val in $pair" ;; esac
    [[ "$key" =~ ^[a-z_]+$ ]] || die "scope permission must match [a-z_]+, got: $key"
    out=$(jq -c --arg k "$key" --arg v "$val" '. + {($k): $v}' <<<"$out")
  done
  echo "$out"
}

load_private_key_pem() {
  # Resolves GITHUB_APP_PRIVATE_KEY which may be:
  #  - a literal PEM starting with "-----BEGIN"
  #  - an absolute path to a PEM file
  #  - a base64-encoded PEM (single line)
  local v="${GITHUB_APP_PRIVATE_KEY:-}"
  [[ -n "$v" ]] || die "GITHUB_APP_PRIVATE_KEY not set"
  if [[ "$v" == "-----BEGIN"* ]]; then
    printf '%s' "$v"
  elif [[ -f "$v" ]]; then
    cat "$v"
  else
    local decoded
    decoded=$(printf '%s' "$v" | base64 -d 2>/dev/null) || die "GITHUB_APP_PRIVATE_KEY: not PEM, not a file, not base64"
    [[ "$decoded" == "-----BEGIN"* ]] || die "GITHUB_APP_PRIVATE_KEY: decoded value is not a PEM"
    printf '%s' "$decoded"
  fi
}

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

make_jwt() {
  local app_id="$1" pem="$2"
  local now=$(date +%s)
  local header='{"alg":"RS256","typ":"JWT"}'
  local payload
  payload=$(jq -nc --argjson iat "$((now - 60))" --argjson exp "$((now + 540))" --argjson iss "$app_id" \
    '{iat:$iat, exp:$exp, iss:$iss}')
  local b64h b64p sig pem_file
  b64h=$(printf '%s' "$header" | b64url)
  b64p=$(printf '%s' "$payload" | b64url)
  pem_file=$(mktemp)
  trap 'rm -f "$pem_file"' RETURN
  printf '%s' "$pem" > "$pem_file"
  sig=$(printf '%s.%s' "$b64h" "$b64p" | openssl dgst -sha256 -sign "$pem_file" -binary | b64url)
  printf '%s.%s.%s' "$b64h" "$b64p" "$sig"
}

resolve_installation_id() {
  local jwt="$1" owner="$2"
  local resp http_code body
  resp=$(curl -sS -w '\n%{http_code}' \
    -H "Authorization: Bearer $jwt" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$GITHUB_API/orgs/$owner/installation" 2>&1) || die "installation lookup failed: $resp"
  http_code=$(tail -n1 <<<"$resp")
  body=$(sed '$d' <<<"$resp")
  if [[ "$http_code" == "404" ]]; then
    # owner may be a user, not an org — try user installation endpoint
    resp=$(curl -sS -w '\n%{http_code}' \
      -H "Authorization: Bearer $jwt" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$GITHUB_API/users/$owner/installation") || die "user installation lookup failed"
    http_code=$(tail -n1 <<<"$resp")
    body=$(sed '$d' <<<"$resp")
  fi
  [[ "$http_code" == "200" ]] || die "cannot resolve installation for $owner (HTTP $http_code): $(jq -r '.message // .' <<<"$body" 2>/dev/null || echo "$body")"
  jq -r '.id' <<<"$body"
}

audit_append() {
  local record="$1"
  mkdir -p "$(dirname "$AUDIT_LOG")" 2>/dev/null || {
    # fall back to a user-writable default if /var/log isn't writable
    local fallback="${HOME:-/tmp}/.cache/pat-broker/audit.jsonl"
    mkdir -p "$(dirname "$fallback")"
    log "audit log $AUDIT_LOG not writable, using $fallback"
    echo "$record" >> "$fallback"
    return
  }
  echo "$record" >> "$AUDIT_LOG"
}

cache_key() {
  local repo="$1" scopes="$2"
  printf '%s|%s' "$repo" "$scopes" | sha256sum | cut -d' ' -f1
}

cache_lookup() {
  local key="$1"
  local path="$CACHE_DIR/$key.json"
  [[ -f "$path" ]] || return 1
  local expires_at now
  expires_at=$(jq -r '.expires_at // empty' "$path") || return 1
  [[ -n "$expires_at" ]] || return 1
  now=$(date -u +%s)
  local exp_epoch
  exp_epoch=$(date -u -d "$expires_at" +%s 2>/dev/null) || return 1
  [[ $((exp_epoch - now)) -gt 60 ]] || return 1
  cat "$path"
}

cache_store() {
  local key="$1" payload="$2"
  mkdir -p "$CACHE_DIR"
  chmod 700 "$CACHE_DIR" 2>/dev/null || true
  local path="$CACHE_DIR/$key.json"
  (umask 177; echo "$payload" > "$path")
}

main() {
  local owner="${REPO%%/*}"
  local name="${REPO##*/}"
  local permissions
  permissions=$(scopes_to_permissions_json "$SCOPES")

  if [[ $DRY_RUN -eq 1 ]]; then
    jq -nc --arg repo "$name" --argjson perms "$permissions" \
      '{repositories:[$repo], permissions:$perms}'
    return 0
  fi

  local key
  key=$(cache_key "$REPO" "$SCOPES")

  local cached cache_state="miss" token expires_at installation_id
  if [[ $NO_CACHE -eq 0 ]] && cached=$(cache_lookup "$key" 2>/dev/null); then
    cache_state="hit"
    token=$(jq -r '.token' <<<"$cached")
    expires_at=$(jq -r '.expires_at' <<<"$cached")
    installation_id=$(jq -r '.installation_id // "0"' <<<"$cached")
  else
    local app_id="${GITHUB_APP_ID:-}"
    [[ -n "$app_id" ]] || die "GITHUB_APP_ID not set (required unless --dry-run)"

    local pem jwt
    pem=$(load_private_key_pem)
    jwt=$(make_jwt "$app_id" "$pem")

    installation_id="${GITHUB_APP_INSTALLATION_ID:-}"
    if [[ -z "$installation_id" ]]; then
      installation_id=$(resolve_installation_id "$jwt" "$owner")
    fi

    local body resp http_code
    body=$(jq -nc --arg repo "$name" --argjson perms "$permissions" \
      '{repositories:[$repo], permissions:$perms}')
    resp=$(curl -sS -w '\n%{http_code}' \
      -X POST \
      -H "Authorization: Bearer $jwt" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -d "$body" \
      "$GITHUB_API/app/installations/$installation_id/access_tokens") || die "mint request failed"
    http_code=$(tail -n1 <<<"$resp")
    local mint_body
    mint_body=$(sed '$d' <<<"$resp")
    [[ "$http_code" == "201" ]] || die "mint failed (HTTP $http_code): $(jq -r '.message // .' <<<"$mint_body" 2>/dev/null || echo "$mint_body")"
    token=$(jq -r '.token' <<<"$mint_body")
    expires_at=$(jq -r '.expires_at' <<<"$mint_body")
    cache_store "$key" "$(jq -nc \
      --arg token "$token" \
      --arg expires_at "$expires_at" \
      --argjson perms "$permissions" \
      --arg repo "$REPO" \
      --arg installation_id "$installation_id" \
      '{token:$token, expires_at:$expires_at, permissions:$perms, repo:$repo, installation_id:$installation_id}')"
  fi

  local audit_id ts
  audit_id=$(openssl rand -hex 8)
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  audit_append "$(jq -nc \
    --arg ts "$ts" \
    --arg audit_id "$audit_id" \
    --arg agent_id "$AGENT_ID" \
    --arg repo "$REPO" \
    --argjson permissions "$permissions" \
    --arg installation_id "$installation_id" \
    --arg cache "$cache_state" \
    --arg expires_at "$expires_at" \
    --argjson ttl_hint "$TTL" \
    '{ts:$ts, audit_id:$audit_id, agent_id:$agent_id, repo:$repo, permissions:$permissions,
      installation_id:(($installation_id|tonumber?) // null), cache:$cache, expires_at:$expires_at, ttl_hint:$ttl_hint}')"

  if [[ $JSON_OUT -eq 1 ]]; then
    jq -nc \
      --arg token "$token" \
      --arg expires_at "$expires_at" \
      --arg repo "$REPO" \
      --argjson permissions "$permissions" \
      --arg audit_id "$audit_id" \
      '{token:$token, expires_at:$expires_at, repo:$repo, permissions:$permissions, audit_id:$audit_id}'
  else
    echo "$token"
  fi
}

main "$@"
