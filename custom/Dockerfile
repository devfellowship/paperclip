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

# PATCH UI: Inbox badge counts only unread touched issues (not all touched).
# Upstream commit 21d2b075 moved badge calc client-side and started counting
# every touched issue (including done) — we want unread-only.
# This requires recompiling the UI bundle since output is content-hashed.
COPY patches/inbox.ts /app/ui/src/lib/inbox.ts
RUN cd /app/ui && rm -rf dist && npx vite build > /tmp/vite-build.log 2>&1 \
    && tail -5 /tmp/vite-build.log \
    && test -d /app/ui/dist/assets \
    && echo "✓ ui rebuilt with inbox badge patch"
# Note: no `USER node` — the entrypoint needs root to remap UID/GID then drops
# to node via gosu. Matches the base paperclip:latest image (v2026.403.0+).
