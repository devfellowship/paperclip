---
name: pat-broker
description: >
  Mint short-lived, scoped GitHub tokens for a single repo and single set of
  permissions. Use instead of reading a global `GITHUB_PAT_*` env var whenever
  an agent needs to call the GitHub API (git push, PR creation, gh CLI, etc.).
  Tokens are GitHub App installation tokens — real attenuation, enforced by
  GitHub itself. Out-of-scope actions return HTTP 403.
---

# pat-broker

Macaroon-style credential attenuation for GitHub. Instead of handing every
agent an omni-scoped PAT, the broker mints a fresh installation token
scoped to exactly the repo(s) and permission(s) the caller declared.

Implements WS-4 of the Harness Reliability Program v2 ([DEV-253](/DEV/issues/DEV-253)).

## Usage

```bash
# Raw token to stdout (safe to `$(...)` into GITHUB_TOKEN)
export GITHUB_TOKEN=$(bash skills/pat-broker/broker.sh \
  --repo devfellowship/dfl-ci \
  --scopes contents:write,pull_requests:write)

# JSON output with expiry + audit id
bash skills/pat-broker/broker.sh \
  --repo devfellowship/dfl-ci \
  --scopes contents:read \
  --json
# → {"token":"ghs_…","expires_at":"…","repo":"…","permissions":{…},"audit_id":"…"}
```

### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--repo OWNER/NAME` | yes | — | Single target repo (must be covered by the App's installation) |
| `--scopes P:ACCESS,…` | yes | — | Comma-separated `permission:level` pairs. Levels: `read`, `write`, `admin` |
| `--ttl SECONDS` | no | 600 | Client-visible hint. Effective TTL is whatever GitHub returns (≤ 3600). |
| `--json` | no | off | Emit full JSON. Default emits just the token. |
| `--no-cache` | no | off | Skip the cache and always mint a fresh token. |
| `--dry-run` | no | off | Print the JSON body that would be POSTed to GitHub; don't mint. |

### Scope vocabulary

Scopes are GitHub App *fine-grained permissions*, not classic OAuth scopes.
The full list lives at
<https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app>.
Common ones:

- `contents:read` / `contents:write`
- `pull_requests:read` / `pull_requests:write`
- `issues:read` / `issues:write`
- `metadata:read` (always implicit)
- `actions:read` / `actions:write`
- `checks:read` / `checks:write`

Unknown permission names are passed through and will be rejected by GitHub if invalid.

## Required env

| Var | Description |
|-----|-------------|
| `GITHUB_APP_ID` | Numeric App ID (e.g. `123456`) |
| `GITHUB_APP_PRIVATE_KEY` | PEM-encoded RSA private key. May be the literal PEM, a path (`/abs/path.pem`), or a base64-encoded PEM. |
| `GITHUB_APP_INSTALLATION_ID` | Optional — numeric installation id. Auto-resolved from `--repo` when unset. |

These come from Infisical path `/shared/` (provisioned once by Tainan; see
`README-setup.md` for the one-time GitHub App setup runbook).

## Caching

Tokens are cached on disk at `${PAT_BROKER_CACHE_DIR:-$HOME/.cache/pat-broker}/`.
Cache key is a sha256 of `(repo|scopes|installation_id)`. A cached token is
reused when it has at least 60 seconds of life remaining; otherwise a fresh
token is minted.

Clear the cache by deleting the directory or passing `--no-cache`.

## Audit log

Every mint (cached or fresh) appends one JSONL record to
`${PAT_BROKER_AUDIT_LOG:-/var/log/paperclip/pat-broker-audit.jsonl}`:

```json
{"ts":"2026-04-16T15:30:01Z","audit_id":"ab12…","agent_id":"dfl-single-repo-impl",
 "repo":"devfellowship/dfl-ci","permissions":{"contents":"write"},
 "installation_id":12345678,"cache":"miss","expires_at":"2026-04-16T16:30:01Z"}
```

- `agent_id` defaults to `$PAPERCLIP_AGENT_ID` or `$OTEL_SERVICE_NAME`; override with `PAT_BROKER_AGENT_ID`.
- 1-week retention via `rotate-audit.sh` (run via cron/routine — see that script).

## Negative test (acceptance)

`tests/negative-out-of-scope.sh` is the live end-to-end proof that scoping
works. It:

1. Mints a `contents:read` token for the test repo.
2. Attempts `PUT /repos/:owner/:repo/contents/.pat-broker-probe` (needs `contents:write`).
3. Asserts the response is HTTP **403** with body mentioning `Resource not accessible`.

Requires `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `PAT_BROKER_TEST_REPO`
(default `devfellowship/pat-broker-probe`). Skipped with a clear message when
App creds are absent.

`tests/smoke.sh` validates broker-internal logic (scope parsing, dry-run JSON
shape, cache hit path) and needs no real GitHub credentials.

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `pat-broker: GITHUB_APP_ID not set` | App creds not in env | Run `infisical-fetch` first, or provision via `README-setup.md` |
| `pat-broker: openssl not found` | Missing system dep | Install `openssl` on the adapter host |
| `404` minting installation token | App not installed on the repo's org | Install the App on that org in GitHub UI, or grant the repo |
| `422` on mint with "permissions … not granted" | Requested scope not in App's configured permissions | Edit the App → add the permission → agents reinstall |
| `jq: command not found` | Missing system dep | Install `jq` on the adapter host |

## Related

- Sibling: [DEV-251](/DEV/issues/DEV-251) credential-presence guard (pre-checks creds exist before task start)
- Sibling: [DEV-252](/DEV/issues/DEV-252) `secrets:need` Telegram escalation (fires when a cred is missing)
- Parent: [DEV-163](/DEV/issues/DEV-163) Harness Reliability Program v2
