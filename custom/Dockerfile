FROM paperclip:latest

USER root

# Install Chromium runtime dependencies for agent-browser
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libatspi2.0-0 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser CLI globally
RUN npm install -g agent-browser

# ─── opencode CLI (open-source coding agent, used by opencode_local adapter) ───
ARG OPENCODE_VERSION=1.4.0
RUN curl -fsSL -o /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
    && mkdir -p /opt/opencode \
    && tar -xzf /tmp/opencode.tar.gz -C /opt/opencode \
    && ln -sf /opt/opencode/opencode /usr/local/bin/opencode \
    && rm /tmp/opencode.tar.gz \
    && /usr/local/bin/opencode --version

# Install GitHub CLI (gh) so agents can run gh pr / gh run / gh api commands
# from inside the container. Required by verify-on-stop hook for ci/api task types.
RUN apt-get update -qq && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update -qq && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ─── Paperclip patches ───────────────────────────────────────────────
# Cost-optimization patches to the heartbeat scheduler:
#   - PATCH 1.1: skip heartbeat when agent has no actionable work
#   - PATCH 1.2: hard timeout for runaway runs (default 20 min)
#   - PATCH 1.3: exponential backoff on consecutive no-work runs
# Source: plans/20260407-paperclip-cost-optimizations.md
#
# The runtime entry point is `server/dist/index.js`, which imports from
# `dist/services/heartbeat.js`. So we must overwrite both the .ts source AND
# the compiled .js. Recompiling via tsc inside the image is the cleanest path.
COPY patches/heartbeat.ts /app/server/src/services/heartbeat.ts
RUN cd /app/server && npx tsc 2>&1 || true \
    && grep -q "skippedNoWork" /app/server/dist/services/heartbeat.js \
    && grep -q "equivalent_api_cost_cents" /app/server/dist/services/heartbeat.js \
    && echo "✓ heartbeat.ts patches compiled into dist/"

# PATCH 4.1: Patch compiled dashboard.js so monthSpend includes the
# equivalent_api_cost_cents column (which heartbeat.ts now populates for
# subscription_included rows). cost_events is the only table in the FROM,
# so the unqualified column name resolves cleanly.
RUN sed -i 's|coalesce(sum(${costEvents.costCents}), 0)::int|coalesce(sum(${costEvents.costCents} + coalesce(equivalent_api_cost_cents, 0)), 0)::int|' \
    /app/server/dist/services/dashboard.js \
    && grep -q "equivalent_api_cost_cents" /app/server/dist/services/dashboard.js \
    && echo "✓ dashboard.js patched to include equivalent_api_cost_cents"

# NOTE: Inbox badge patch REMOVED — upstream now uses issue.isUnreadForMe
# (same intent as our getUnreadTouchedIssues patch). Our patches/inbox.ts is
# stale (older upstream baseline) and overwriting the newer file breaks vite
# build. No UI rebuild needed; upstream already has the desired behavior.

# ─── PATCH 5.1: Deterministic guards (DEV-164 Harness v2 Fase 3) ─────────────
# Adds server/src/services/guards.ts which implements guard checks for
# agent status transitions:
#   in_progress → in_review : requireValidationEvidence, requireOutputSchema,
#                              requirePRUrl, requireRepoCoverage
#   in_review   → done      : requireValidationEvidence, requireOutputSchema
#
# requireRepoCoverage is now FULLY IMPLEMENTED (DEV-165):
#   - Parses "multi-repo-report: {...}" JSON block from transition comment
#   - Validates len(repos_succeeded) + len(repos_failed) == len(repos_targeted)
#   - Blocks with Telegram alert on coverage gap (no silent drops)
#
# When a guard fails:
#   - The requested status is overridden to "blocked" (auto-transition)
#   - blockerService.create() fires a Telegram notification to #1304
#   - The PATCH response returns the blocked issue so the agent can react
#
# Source: plans/20260411-harness-reliability-program-v2 (Fase 3 + 4)
# Depends on: DEV-161 (blockerService), DEV-164 (guards wiring), DEV-165 (this)
COPY patches/guards.ts /app/server/src/services/guards.ts

# PATCH 5.2: Inject runGuards into the PATCH /issues/:id route handler.
# patch-guards.js surgically patches routes/issues.ts:
#   1. Adds `import { runGuards } from "../services/guards.js";`
#   2. Inserts a guard block before `let issue;` in the route body
# Then recompiles the full server with tsc.
COPY patches/patch-guards.cjs /tmp/patch-guards.cjs
RUN node /tmp/patch-guards.cjs \
    && cd /app/server && npx tsc 2>&1 || true \
    && grep -q "runGuards" /app/server/dist/routes/issues.js \
    && grep -q "runGuards" /app/server/dist/services/guards.js \
    && echo "✓ guards.ts compiled into dist/services/guards.js and wired into routes/issues.js"

# ─── PATCH 6.1: multi-gitter CLI (DEV-165 Harness v2 Fase 4) ──────────────────
# Installs multi-gitter, the fleet-wide PR automation tool.
# Used by the multi-repo-rollout task type executed by dfl-rollout-ops.
# Pinned version for reproducibility — bump deliberately.
# Source: https://github.com/lindell/multi-gitter
ARG MULTI_GITTER_VERSION=0.63.0
RUN ARCH=$(dpkg --print-architecture | sed 's/amd64/x86_64/;s/arm64/ARM64/') \
    && curl -fsSL -o /tmp/multi-gitter.tar.gz \
       "https://github.com/lindell/multi-gitter/releases/download/v${MULTI_GITTER_VERSION}/multi-gitter_${MULTI_GITTER_VERSION}_Linux_${ARCH}.tar.gz" \
    && tar -xzf /tmp/multi-gitter.tar.gz -C /usr/local/bin multi-gitter \
    && rm /tmp/multi-gitter.tar.gz \
    && chmod +x /usr/local/bin/multi-gitter \
    && multi-gitter version \
    && echo "✓ multi-gitter ${MULTI_GITTER_VERSION} installed"

# PATCH 6.2: multi-gitter adapter service
# Copies server/src/services/multi-gitter.ts into the compiled server and
# recompiles with tsc so it becomes importable by dfl-rollout-ops via the
# Paperclip skill layer.
COPY patches/multi-gitter.ts /app/server/src/services/multi-gitter.ts
RUN cd /app/server && npx tsc 2>&1 || true \
    && test -f /app/server/dist/services/multi-gitter.js \
    && grep -q "invokeMultiGitter" /app/server/dist/services/multi-gitter.js \
    && echo "✓ multi-gitter.ts compiled into dist/services/multi-gitter.js"

# Note: no `USER node` — the entrypoint needs root to remap UID/GID then drops
# to node via gosu. Matches the base paperclip:latest image (v2026.403.0+).
