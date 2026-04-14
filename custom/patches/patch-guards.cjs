#!/usr/bin/env node
// DEV-164 PATCH 5.2 — Inject deterministic guards into routes/issues.ts
// Run during Docker image build (see custom/Dockerfile PATCH 5.2 step).

const fs = require("fs");
const src = "/app/server/src/routes/issues.ts";
let content = fs.readFileSync(src, "utf8");

// ── 1. Inject import ────────────────────────────────────────────────────────
const IMPORT_ANCHOR =
  'import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";';
const GUARD_IMPORT =
  IMPORT_ANCHOR +
  '\nimport { runGuards } from "../services/guards.js";';

if (!content.includes("runGuards")) {
  if (!content.includes(IMPORT_ANCHOR)) {
    throw new Error(
      "PATCH 5.2: import anchor not found in routes/issues.ts — " +
        "upstream may have changed. Update patch-guards.js anchor."
    );
  }
  content = content.replace(IMPORT_ANCHOR, GUARD_IMPORT);
  console.log("  ✓ injected runGuards import");
} else {
  console.log("  – runGuards import already present, skipping");
}

// ── 2. Inject guard block before `let issue;` ────────────────────────────────
const ISSUE_LET_ANCHOR = "    let issue;\n    try {";
const GUARD_BLOCK = `\
    // PATCH 5.2: Deterministic guards (DEV-164 Harness v2 Fase 3)
    // Intercepts agent transitions in_progress→in_review and in_review→done.
    // On failure: overrides status to "blocked" and fires Telegram notification.
    if (typeof updateFields.status === "string" && actor.actorType === "agent") {
      const guardResults = runGuards({
        issue: existing,
        requestedStatus: updateFields.status,
        comment: commentBody ?? "",
        actorType: actor.actorType,
      });
      const failedGuard = guardResults.find((g) => !g.ok);
      if (failedGuard) {
        updateFields.status = "blocked";
        void blockersSvc
          .create({
            taskId: existing.id,
            agentId: actor.agentId ?? "unknown",
            summary: "Guard blocked transition: " + (failedGuard.reason ?? "guard check failed"),
            needs: failedGuard.reason ?? "Fix the transition report before re-submitting",
            context:
              "Status transition " +
              existing.status +
              " \u2192 blocked (guard). Issue: " +
              (existing.identifier ?? existing.id),
            issueTitle: existing.title ?? undefined,
            issueIdentifier: existing.identifier ?? undefined,
          })
          .catch((err) =>
            logger.warn(
              { err, issueId: existing.id },
              "guard: blocker notification failed"
            )
          );
      }
    }
    let issue;
    try {`;

if (!content.includes("PATCH 5.2")) {
  if (!content.includes(ISSUE_LET_ANCHOR)) {
    throw new Error(
      "PATCH 5.2: 'let issue;' anchor not found in routes/issues.ts — " +
        "upstream may have changed. Update patch-guards.js anchor."
    );
  }
  content = content.replace(ISSUE_LET_ANCHOR, GUARD_BLOCK);
  console.log("  ✓ injected guard block before 'let issue;'");
} else {
  console.log("  – guard block already present, skipping");
}

fs.writeFileSync(src, content);
console.log("routes/issues.ts patched with deterministic guards (PATCH 5.2)");
