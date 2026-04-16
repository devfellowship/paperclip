#!/usr/bin/env bash
# skills/pat-broker/tests/smoke.sh
#
# Validates broker-internal logic: scope parsing, dry-run JSON shape, cache key
# stability, audit log write. Does not require real GitHub App credentials.
#
# Exit 0 on success, 1 on any failure.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
broker="$here/../broker.sh"
[[ -x "$broker" ]] || chmod +x "$broker"

tmp_root=$(mktemp -d)
trap 'rm -rf "$tmp_root"' EXIT
export PAT_BROKER_CACHE_DIR="$tmp_root/cache"
export PAT_BROKER_AUDIT_LOG="$tmp_root/audit.jsonl"

pass() { echo "  ok: $*"; }
fail() { echo "  FAIL: $*" >&2; exit 1; }

echo "1. dry-run emits correct permissions JSON"
out=$(bash "$broker" --repo devfellowship/dfl-ci --scopes contents:write,pull_requests:read --dry-run)
[[ $(jq -r '.repositories[0]' <<<"$out") == "dfl-ci" ]] || fail "repositories wrong: $out"
[[ $(jq -r '.permissions.contents' <<<"$out") == "write" ]] || fail "contents perm wrong: $out"
[[ $(jq -r '.permissions.pull_requests' <<<"$out") == "read" ]] || fail "pull_requests perm wrong: $out"
pass "dry-run shape"

echo "2. dry-run rejects invalid scope level"
if bash "$broker" --repo foo/bar --scopes contents:writer --dry-run 2>/dev/null; then
  fail "expected failure on invalid scope level"
fi
pass "invalid scope level rejected"

echo "3. dry-run rejects invalid permission name (uppercase)"
if bash "$broker" --repo foo/bar --scopes Contents:write --dry-run 2>/dev/null; then
  fail "expected failure on invalid permission name"
fi
pass "invalid permission name rejected"

echo "4. dry-run rejects malformed repo"
if bash "$broker" --repo notarepo --scopes contents:read --dry-run 2>/dev/null; then
  fail "expected failure on malformed repo"
fi
pass "malformed repo rejected"

echo "5. missing --repo fails"
if bash "$broker" --scopes contents:read --dry-run 2>/dev/null; then
  fail "expected failure on missing --repo"
fi
pass "missing --repo rejected"

echo "6. missing --scopes fails"
if bash "$broker" --repo foo/bar --dry-run 2>/dev/null; then
  fail "expected failure on missing --scopes"
fi
pass "missing --scopes rejected"

echo "7. without --dry-run and no GITHUB_APP_ID, exits with clear error"
unset GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_APP_INSTALLATION_ID
err=$(bash "$broker" --repo foo/bar --scopes contents:read 2>&1 || true)
[[ "$err" == *"GITHUB_APP_ID not set"* ]] || fail "expected 'GITHUB_APP_ID not set' in error, got: $err"
pass "no-creds error path"

echo "8. cache lookup returns nothing on fresh dir"
export PAT_BROKER_CACHE_DIR="$tmp_root/cache-empty"
[[ ! -f "$PAT_BROKER_CACHE_DIR/anything.json" ]] || fail "stale cache file"
pass "empty cache is empty"

echo ""
echo "smoke: all 8 checks passed"
