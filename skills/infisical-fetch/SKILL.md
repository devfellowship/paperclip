---
name: infisical-fetch
description: >
  Fetch secrets from Infisical at heartbeat start and inject them as env vars.
  Use at the beginning of each heartbeat to hydrate INFISICAL_CLIENT_ID,
  INFISICAL_CLIENT_SECRET, and any agent-specific or shared secrets before
  doing domain work.
---

# Infisical Fetch Skill

Fetches secrets from the self-hosted Infisical vault and makes them available as
environment variables for the rest of the heartbeat.

## When to use

Run this skill **at the start of every heartbeat** — before doing any domain
work that requires credentials (GitHub PATs, API keys, etc.). If a secret is
missing at runtime it means either the fetch failed or the secret was never
provisioned; see Troubleshooting below.

## Prerequisites

The agent must have these env vars injected by the Paperclip adapter config:

| Var | Description |
|-----|-------------|
| `INFISICAL_CLIENT_ID` | Universal Auth client ID for this agent's machine identity |
| `INFISICAL_CLIENT_SECRET` | Universal Auth client secret for this agent's machine identity |

Optional overrides:

| Var | Default | Description |
|-----|---------|-------------|
| `INFISICAL_API_URL` | `https://infisical.devfellowship.com` | Infisical server URL |
| `INFISICAL_PROJECT_ID` | `f9572f70-c99d-4a44-8686-e9e83ff5a8fe` | personal-vaults-tainan project |
| `INFISICAL_ENV` | `prod` | Infisical environment slug |
| `INFISICAL_AGENT_NAME` | derived from agent urlKey | Path suffix under `/agents/` |

## How it works

1. **Authenticate** — POST to Universal Auth login with `CLIENT_ID` + `CLIENT_SECRET` → receives a short-lived `accessToken` (2h TTL).
2. **Export `/agents/{agent-name}/`** — agent-specific secrets (credentials scoped to this agent).
3. **Export `/shared/`** — cross-agent secrets (shared infrastructure tokens).
4. **Inject** — eval the dotenv output so secrets are available as env vars in subsequent commands.

## Usage

Run this at the top of any heartbeat that needs secrets:

```bash
# Step 1: authenticate
INFISICAL_ACCESS_TOKEN=$(curl -s \
  -X POST "${INFISICAL_API_URL:-https://infisical.devfellowship.com}/api/v1/auth/universal-auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"clientId\":\"$INFISICAL_CLIENT_ID\",\"clientSecret\":\"$INFISICAL_CLIENT_SECRET\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")

# Step 2: export agent-specific secrets (replace dev-dfl with your agent name)
eval $(infisical export \
  --domain="${INFISICAL_API_URL:-https://infisical.devfellowship.com}" \
  --token="$INFISICAL_ACCESS_TOKEN" \
  --projectId="${INFISICAL_PROJECT_ID:-f9572f70-c99d-4a44-8686-e9e83ff5a8fe}" \
  --env="${INFISICAL_ENV:-prod}" \
  --path="/agents/${INFISICAL_AGENT_NAME:-AGENT_NAME_HERE}/" \
  --format=dotenv \
  --silent 2>/dev/null)

# Step 3: export shared secrets
eval $(infisical export \
  --domain="${INFISICAL_API_URL:-https://infisical.devfellowship.com}" \
  --token="$INFISICAL_ACCESS_TOKEN" \
  --projectId="${INFISICAL_PROJECT_ID:-f9572f70-c99d-4a44-8686-e9e83ff5a8fe}" \
  --env="${INFISICAL_ENV:-prod}" \
  --path="/shared/" \
  --format=dotenv \
  --silent 2>/dev/null)
```

Or use the bundled helper script:

```bash
eval $(bash skills/infisical-fetch/fetch.sh)
```

The helper script auto-detects the agent name from `INFISICAL_AGENT_NAME` and
falls back gracefully if a path has no secrets.

## Agent name → Infisical path mapping

The Infisical `/agents/{name}/` path uses the agent's **short name** as defined
in the Paperclip machine identity convention:

| Paperclip urlKey | Infisical path |
|-----------------|----------------|
| `dev-dfl-architect` | `/agents/dev-dfl/` |
| `dfl-tech-spec-owner` | `/agents/dfl-tech-spec-owner/` |
| `dfl-rollout-ops` | `/agents/dfl-rollout-ops/` |
| `dfl-single-repo-impl` | `/agents/dfl-single-repo-impl/` |
| `dfl-verifier` | `/agents/dfl-verifier/` |

Set `INFISICAL_AGENT_NAME` in the adapter `env` config to match the path above.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `INFISICAL_CLIENT_ID not set` | Credential not injected by adapter | Add to agent `adapterConfig.env` |
| Auth 401 / `Unauthorized` | Wrong client_id/secret or identity not added to project | Verify identity is Viewer on personal-vaults-tainan |
| Secret not found after eval | Secret not yet provisioned | Ask Bro to add it at `/agents/{name}/{SECRET_NAME}` |
| `infisical: command not found` | CLI not installed on host | Install: `curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh' \| bash && apt install infisical` |
| Empty output from export | Path exists but has no secrets | Normal — path has no secrets yet |

## Credential request workflow

If a secret is missing and blocking work:

1. Mark the Paperclip issue as `blocked` with a comment:
   > Blocked: need `SECRET_NAME` at `/agents/{agent-name}/SECRET_NAME` in Infisical
2. Paperclip will notify Tainan via Telegram `#credential-requests`.
3. Tainan asks Bro to provision the secret.
4. On next heartbeat, run this skill again — the secret will be available.

## Infisical details

- Server: `https://infisical.devfellowship.com`
- Project: `personal-vaults-tainan` (id: `f9572f70-c99d-4a44-8686-e9e83ff5a8fe`)
- Environment: `prod`
- Auth method: Universal Auth (2h TTL, renewable)
- Path resolution order: `/agents/{name}/` then `/shared/` (shared can be overridden by agent-specific)
