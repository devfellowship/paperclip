# DevFellowship Custom Paperclip Overlay

Custom Dockerfile and patches applied on top of the upstream `paperclip:latest` image
to produce `paperclip:custom` for the DFL deployment.

## What's in here

### `Dockerfile`
Extends `paperclip:latest` with:
- **Chromium runtime libs** for `agent-browser` (headless browser tool)
- **`agent-browser` CLI** (`npm install -g agent-browser`)
- **`gh` CLI** (GitHub CLI for agents)
- **`opencode` CLI** v1.4.0 (open-source coding agent, used by `opencode_local` adapter)
- **PATCH 1.1**: heartbeat skips agents with 0 actionable issues
- **PATCH 1.2**: hard 20-min runaway timeout for long-running heartbeats
- **PATCH 1.3**: exponential backoff on consecutive no-work runs
- **PATCH 4.1**: `equivalent_api_cost_cents` column on `cost_events` + dashboard sum
- **PATCH UI**: inbox badge counts only unread touched issues (not all touched)

### `patches/`
- `heartbeat.ts` — patched source (COPY'd into image, recompiled via `npx tsc`)
- `heartbeat.ts.original` — pristine upstream baseline (kept for diffing on upgrades)
- `inbox.ts` — patched inbox UI source (COPY'd, rebuilt via `npx vite build`)
- `inbox.ts.original` — pristine upstream baseline

### `docker-compose.yml`
Production stack config for DFL Paperclip deployment (postgres + server).
Env vars are `${...}` references — actual values live in `.env` (not committed).

## How to build & deploy

```bash
# 1. Build upstream base (from repo root)
docker build -t paperclip:latest .

# 2. Build custom overlay
cd custom && docker build -t paperclip:custom .

# 3. Deploy (MUST source .env first!)
cd custom
set -a; source /path/to/.env; set +a
docker stack deploy -c docker-compose.yml paperclip
docker service update --force paperclip_server
```

**Critical:** Never add `USER node` at the end of the Dockerfile — the entrypoint
needs root for UID/GID remapping, then drops to node via gosu.

## Upgrading to a new Paperclip release

1. Rebuild `paperclip:latest` from updated repo root
2. Diff `patches/heartbeat.ts.original` against the NEW upstream `heartbeat.ts`
3. Apply our deltas to the new version, save as `patches/heartbeat.ts`
4. Update `patches/heartbeat.ts.original` to the new pristine baseline
5. Same for `inbox.ts` / `inbox.ts.original`
6. Rebuild `paperclip:custom`, test, deploy
