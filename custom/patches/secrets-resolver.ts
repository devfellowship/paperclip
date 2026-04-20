/**
 * DEV-252 — secrets-resolver
 *
 * Closes the WS-4 credential loop. When the credential guard (DEV-251) blocks
 * a task because the assignee is missing a required credential, blockersSvc
 * posts a message to the Telegram #blockers topic with one `paste: KEY=<value>`
 * hint per missing capability. An operator replies in the same thread with
 * `paste: KEY=<actualvalue>`; Telegram forwards that message to the
 * server-side webhook registered below; we store the value in Infisical under
 * `/agents/<agent-name>/<KEY>` and return the blocked task to `todo` so it
 * re-checks out on the next heartbeat.
 *
 * Plumbing:
 *   - POST /api/telegram/blockers-webhook (mounted from the patched blockers
 *     route) — secured with the Telegram `secret_token` header echoed to
 *     TELEGRAM_WEBHOOK_SECRET.
 *   - secretsResolverService(db).handleTelegramUpdate({ update }) is the
 *     entry point. It is idempotent per `update_id` (best-effort dedup) and
 *     never logs the pasted value.
 */
import { and, desc, eq, isNull, like, or } from "drizzle-orm";
import { blockerNotifications } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { blockerService } from "./blockers.js";
import { issueService } from "./issues.js";
import { agentService } from "./agents.js";
import { capabilitiesForPasteKey } from "./task-types.js";

// Single `paste: KEY=value` line. KEY is uppercase letters/digits/underscore
// (matches Infisical + shell-env convention). Value is everything after the
// first `=` up to the end of line — we trim later. We match the line start
// anchor with the `m` flag so operators can include extra lines of context.
const PASTE_LINE_RE = /^paste:\s*([A-Z][A-Z0-9_]{1,63})\s*=\s*(.+?)\s*$/m;

// Envelope accepted from Telegram. Keep the type permissive — Telegram adds
// fields over time and we only care about a small slice.
export interface TelegramUpdatePayload {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

interface TelegramMessage {
  message_id?: number;
  message_thread_id?: number;
  chat?: { id?: number | string };
  from?: { id?: number; username?: string };
  text?: string;
  reply_to_message?: { message_id?: number };
}

export interface ParsedPaste {
  pasteKey: string;
  value: string;
}

export function parseTelegramReply(text: string | undefined | null): ParsedPaste | null {
  if (!text) return null;
  const match = PASTE_LINE_RE.exec(text);
  if (!match) return null;
  const pasteKey = match[1];
  const value = match[2].trim();
  if (!pasteKey || !value) return null;
  // Guard against the operator accidentally pasting the placeholder.
  if (value === "<value>" || value.startsWith("<value>")) return null;
  return { pasteKey, value };
}

interface InfisicalWriteInput {
  apiUrl: string;
  projectId: string;
  environment: string;
  path: string;
  key: string;
  value: string;
  clientId: string;
  clientSecret: string;
}

async function infisicalWriteSecret(input: InfisicalWriteInput): Promise<void> {
  // Universal Auth: exchange client id/secret for a short-lived access token.
  const authRes = await fetch(`${input.apiUrl}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: input.clientId, clientSecret: input.clientSecret }),
  });
  if (!authRes.ok) {
    const body = await authRes.text().catch(() => "unknown");
    throw new Error(`Infisical auth failed: ${authRes.status} ${body}`);
  }
  const authJson = (await authRes.json()) as { accessToken?: string };
  const accessToken = authJson.accessToken;
  if (!accessToken) throw new Error("Infisical auth returned no accessToken");

  // v3 upsert: try POST (create), fall back to PATCH (update) on 409.
  const writeUrl = `${input.apiUrl}/api/v3/secrets/raw/${encodeURIComponent(input.key)}`;
  const writeBody = {
    workspaceId: input.projectId,
    environment: input.environment,
    secretPath: input.path,
    secretValue: input.value,
    type: "shared" as const,
  };

  let res = await fetch(writeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(writeBody),
  });
  if (res.status === 409) {
    res = await fetch(writeUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(writeBody),
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown");
    throw new Error(`Infisical write failed: ${res.status} ${body}`);
  }
}

function agentInfisicalSlug(agent: {
  urlKey?: string | null;
  name?: string | null;
  adapterConfig?: unknown;
}): string {
  const cfg = agent.adapterConfig as Record<string, unknown> | null | undefined;
  const env = cfg?.env as Record<string, unknown> | undefined;
  const override = env?.["INFISICAL_AGENT_NAME"];
  if (override && typeof override === "object" && override !== null) {
    const val = (override as { value?: unknown }).value;
    if (typeof val === "string" && val.length > 0) return val;
  }
  if (typeof override === "string" && override.length > 0) return override;
  return agent.urlKey ?? agent.name ?? "unknown";
}

export interface ResolveResult {
  status:
    | "ok"
    | "no_match"
    | "parse_failed"
    | "unknown_key"
    | "missing_config"
    | "write_failed"
    | "duplicate";
  blockerId?: number;
  taskId?: string;
  pasteKey?: string;
}

export function secretsResolverService(db: Db) {
  const blockersSvc = blockerService(db);
  const issueSvc = issueService(db);
  const agentsSvc = agentService(db);

  // Best-effort dedup for redelivered Telegram updates. Small in-process set;
  // restart empties it, which is fine because Infisical writes are idempotent
  // on value equality.
  const seenUpdateIds = new Set<number>();

  return {
    async findBlockerForKey(pasteKey: string) {
      // The guard writes `paste: KEY=<value>` into the blocker's `needs` body.
      // We also accept the `secrets:need <CAP>` grep anchor so a reply with a
      // capability-level key can fall back to the correct capability.
      const capabilities = capabilitiesForPasteKey(pasteKey);
      const likeTerms = [
        like(blockerNotifications.needs, `%paste: ${pasteKey}=%`),
        ...capabilities.map((cap) => like(blockerNotifications.needs, `%secrets:need %${cap}%`)),
      ];
      const rows = await db
        .select()
        .from(blockerNotifications)
        .where(and(isNull(blockerNotifications.resolvedAt), or(...likeTerms)))
        .orderBy(desc(blockerNotifications.postedAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async handleTelegramUpdate(input: {
      update: TelegramUpdatePayload;
      expectedChatId?: string | null;
      expectedThreadId?: number | null;
    }): Promise<ResolveResult> {
      const { update } = input;
      if (update.update_id != null) {
        if (seenUpdateIds.has(update.update_id)) {
          return { status: "duplicate" };
        }
        seenUpdateIds.add(update.update_id);
        if (seenUpdateIds.size > 1000) {
          // Bounded memory: drop the oldest entries. Iteration is insertion-
          // order in JS so deleting the first element approximates a FIFO.
          const first = seenUpdateIds.values().next().value;
          if (first !== undefined) seenUpdateIds.delete(first);
        }
      }

      const msg = update.message ?? update.edited_message ?? update.channel_post;
      if (!msg || !msg.text) return { status: "parse_failed" };

      // Enforce chat + thread scoping so a leaked webhook URL can't be
      // triggered by messages outside the blockers topic.
      if (input.expectedChatId != null && String(msg.chat?.id ?? "") !== String(input.expectedChatId)) {
        return { status: "parse_failed" };
      }
      if (input.expectedThreadId != null && msg.message_thread_id !== input.expectedThreadId) {
        return { status: "parse_failed" };
      }

      const parsed = parseTelegramReply(msg.text);
      if (!parsed) return { status: "parse_failed" };

      // Reject pastes whose key isn't registered under any known capability.
      // This prevents arbitrary writes (`paste: FOO=…`) from landing in
      // Infisical when no blocker asked for FOO.
      const matchedCapabilities = capabilitiesForPasteKey(parsed.pasteKey);
      if (matchedCapabilities.length === 0) {
        return { status: "unknown_key", pasteKey: parsed.pasteKey };
      }

      const blocker = await this.findBlockerForKey(parsed.pasteKey);
      if (!blocker) {
        return { status: "no_match", pasteKey: parsed.pasteKey };
      }

      const agent = await agentsSvc.getById(blocker.agentId).catch(() => null);
      if (!agent) {
        return { status: "no_match", pasteKey: parsed.pasteKey, blockerId: blocker.id };
      }

      const apiUrl = process.env.INFISICAL_API_URL ?? "https://infisical.devfellowship.com";
      const projectId = process.env.INFISICAL_PROJECT_ID;
      const environment = process.env.INFISICAL_ENV ?? "prod";
      const clientId = process.env.INFISICAL_SERVER_CLIENT_ID;
      const clientSecret = process.env.INFISICAL_SERVER_CLIENT_SECRET;

      if (!projectId || !clientId || !clientSecret) {
        logger.warn(
          { missing: { projectId: !projectId, clientId: !clientId, clientSecret: !clientSecret } },
          "secrets-resolver: Infisical server identity not configured",
        );
        return { status: "missing_config", pasteKey: parsed.pasteKey, blockerId: blocker.id };
      }

      const slug = agentInfisicalSlug(agent);
      const secretPath = `/agents/${slug}/`;

      try {
        await infisicalWriteSecret({
          apiUrl,
          projectId,
          environment,
          path: secretPath,
          key: parsed.pasteKey,
          value: parsed.value,
          clientId,
          clientSecret,
        });
      } catch (err) {
        logger.error(
          { err, blockerId: blocker.id, pasteKey: parsed.pasteKey },
          "secrets-resolver: Infisical write failed",
        );
        return { status: "write_failed", pasteKey: parsed.pasteKey, blockerId: blocker.id };
      }

      // Edit the Telegram message to "Resolved" and move the task back to
      // `todo` so the assignee re-checks out and re-runs the guard.
      await blockersSvc
        .resolveByTaskId(blocker.taskId)
        .catch((err) =>
          logger.warn({ err, taskId: blocker.taskId }, "secrets-resolver: resolveByTaskId failed"),
        );

      await issueSvc
        .update(blocker.taskId, { status: "todo" })
        .catch((err) =>
          logger.warn({ err, taskId: blocker.taskId }, "secrets-resolver: issue update failed"),
        );

      await issueSvc
        .addComment(
          blocker.taskId,
          `Credential \`${parsed.pasteKey}\` pasted via Telegram reply → stored at \`${secretPath}${parsed.pasteKey}\` in Infisical.\n\nTask returned to \`todo\`; will re-checkout on next heartbeat.`,
          { agentId: blocker.agentId },
        )
        .catch((err) =>
          logger.warn({ err, taskId: blocker.taskId }, "secrets-resolver: addComment failed"),
        );

      logger.info(
        { blockerId: blocker.id, taskId: blocker.taskId, pasteKey: parsed.pasteKey, slug },
        "secrets-resolver: credential resolved + task resumed",
      );

      return {
        status: "ok",
        blockerId: blocker.id,
        taskId: blocker.taskId,
        pasteKey: parsed.pasteKey,
      };
    },
  };
}
