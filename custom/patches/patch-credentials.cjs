#!/usr/bin/env node
// DEV-251 PATCH 7.1 — Inject credential guard into POST /issues/:id/checkout
// Run during Docker image build (see custom/Dockerfile PATCH 7.1 step).
//
// At checkout time, if the issue has a task_type, the server checks that the
// assignee agent's adapterConfig.env contains all required credential keys.
// Missing creds → issue auto-transitions to "blocked" with a secrets:need note.

const fs = require("fs");
const src = "/app/server/src/routes/issues.ts";
let content = fs.readFileSync(src, "utf8");

// ── 1. Inject import ────────────────────────────────────────────────────────
const IMPORT_ANCHOR = 'import { runGuards } from "../services/guards.js";';
const CRED_IMPORT =
  IMPORT_ANCHOR +
  '\nimport { checkRequiredCredentials } from "../services/task-types.js";';

if (!content.includes("checkRequiredCredentials")) {
  if (!content.includes(IMPORT_ANCHOR)) {
    throw new Error(
      "PATCH 7.1: runGuards import anchor not found in routes/issues.ts — " +
        "update patch-credentials.cjs anchor."
    );
  }
  content = content.replace(IMPORT_ANCHOR, CRED_IMPORT);
  console.log("  \u2713 injected checkRequiredCredentials import");
} else {
  console.log("  \u2013 checkRequiredCredentials import already present, skipping");
}

// ── 2. Inject credential check between svc.checkout() and getActorInfo() ─────
// Anchored on the two consecutive lines that always appear together.
const CHECKOUT_ANCHOR =
  "    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);\n" +
  "    const actor = getActorInfo(req);";

const CRED_CHECK_BLOCK =
  "    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);\n" +
  "\n" +
  "    // PATCH 7.1: Credential guard (DEV-251 Harness v2 WS-4)\n" +
  "    // After checkout succeeds, verify the assignee agent has all required\n" +
  "    // credentials for the task type. Missing creds → auto-block + Telegram.\n" +
  "    if (req.actor.type === \"agent\") {\n" +
  "      try {\n" +
  "        const assigneeAgent = await agentsSvc.getById(req.body.agentId);\n" +
  "        const agentEnvKeys = Object.keys(\n" +
  "          ((assigneeAgent?.adapterConfig as Record<string, unknown> | null | undefined)?.[\"env\"] ?? {}) as object\n" +
  "        );\n" +
  "        const taskBodyObj = updated.taskBody as Record<string, unknown> | null | undefined;\n" +
  "        const requiredOverride = Array.isArray(taskBodyObj?.[\"required_credentials\"])\n" +
  "          ? (taskBodyObj![\"required_credentials\"] as string[])\n" +
  "          : null;\n" +
  "        const credCheck = checkRequiredCredentials(updated.taskType, agentEnvKeys, requiredOverride);\n" +
  "        if (!credCheck.ok) {\n" +
  "          const missingList = credCheck.missing.join(\", \");\n" +
  "          const blockedComment =\n" +
  "            `Credential guard blocked task start.\\n\\n` +\n" +
  "            `Missing credentials: **${missingList}**\\n\\n` +\n" +
  "            `Add these to the agent's Infisical path (\`/agents/<name>/\`) or adapterConfig.env,` +\n" +
  "            ` then re-checkout.\\n\\nsecrets:need ${missingList}`;\n" +
  "          await svc.update(\n" +
  "            updated.id,\n" +
  "            { status: \"blocked\", actorAgentId: req.body.agentId },\n" +
  "          ).catch((err: unknown) => logger.warn({ err, issueId: updated.id }, \"cred guard: failed to block issue\"));\n" +
  "          await svc.addComment(updated.id, blockedComment, {\n" +
  "            agentId: req.body.agentId,\n" +
  "            runId: checkoutRunId ?? undefined,\n" +
  "          }).catch((err: unknown) => logger.warn({ err, issueId: updated.id }, \"cred guard: failed to add comment\"));\n" +
  "          void blockersSvc\n" +
  "            .create({\n" +
  "              taskId: updated.id,\n" +
  "              agentId: req.body.agentId,\n" +
  "              summary: `Credential guard: missing ${missingList}`,\n" +
  "              needs: `Provision in Infisical /agents/<name>/: ${missingList}`,\n" +
  "              context:\n" +
  "                `Checkout blocked for ${updated.identifier ?? updated.id} — ` +\n" +
  "                `task_type=${updated.taskType ?? \"(unset)\"}, missing=${missingList}`,\n" +
  "              issueTitle: updated.title ?? undefined,\n" +
  "              issueIdentifier: updated.identifier ?? undefined,\n" +
  "            })\n" +
  "            .catch((err: unknown) => logger.warn({ err }, \"cred guard: blockersSvc.create failed\"));\n" +
  "          const blockedIssue = await svc.getById(updated.id);\n" +
  "          res.json(blockedIssue ?? updated);\n" +
  "          return;\n" +
  "        }\n" +
  "      } catch (err) {\n" +
  "        logger.warn({ err, issueId: updated.id }, \"cred guard: unexpected error, skipping check\");\n" +
  "      }\n" +
  "    }\n" +
  "\n" +
  "    const actor = getActorInfo(req);";

if (!content.includes("PATCH 7.1")) {
  if (!content.includes(CHECKOUT_ANCHOR)) {
    throw new Error(
      "PATCH 7.1: checkout anchor not found in routes/issues.ts — " +
        "upstream may have changed. Update patch-credentials.cjs anchor."
    );
  }
  content = content.replace(CHECKOUT_ANCHOR, CRED_CHECK_BLOCK);
  console.log("  \u2713 injected credential check block into checkout route");
} else {
  console.log("  \u2013 credential check block already present, skipping");
}

fs.writeFileSync(src, content);
console.log("patch-credentials.cjs: done");
