import { createHash } from "node:crypto";
import { eq, and, gt, isNull, sql } from "drizzle-orm";
import { blockerNotifications, issues, agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { scrubCredentials } from "./blocker-credential-scrubber.js";
import { logger } from "../middleware/logger.js";

const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Convert BigInt fields to Number for JSON serialization */
function toJsonSafe<T extends Record<string, unknown>>(row: T): T {
  const result = { ...row };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "bigint") {
      (result as Record<string, unknown>)[key] = Number(value);
    }
  }
  return result;
}

function computeBlockerHash(taskId: string, needs: string): string {
  return createHash("sha256").update(`${taskId}|${needs}`).digest("hex");
}

function truncateToLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + "...";
}

function buildIssueUrl(identifier: string): string {
  const baseUrl = process.env.PAPERCLIP_PUBLIC_URL ?? "https://app.paperclip.ing";
  const prefix = identifier.split("-")[0];
  return `${baseUrl}/${prefix}/issues/${identifier}`;
}

async function sendTelegramMessage(text: string): Promise<number | null> {
  const token = process.env.TELEGRAM_BLOCKERS_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_BLOCKERS_CHAT_ID;
  const threadId = process.env.TELEGRAM_BLOCKERS_THREAD_ID;

  if (!token || !chatId) {
    logger.warn("TELEGRAM_BLOCKERS_BOT_TOKEN or TELEGRAM_BLOCKERS_CHAT_ID not set, skipping Telegram post");
    return null;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (threadId) {
    body.message_thread_id = Number(threadId);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "unknown");
    logger.error({ status: res.status, body: errorBody }, "Failed to send Telegram blocker message");
    return null;
  }

  const data = (await res.json()) as { result?: { message_id?: number } };
  return data.result?.message_id ?? null;
}

async function editTelegramMessage(messageId: number, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BLOCKERS_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_BLOCKERS_CHAT_ID;

  if (!token || !chatId) {
    logger.warn("TELEGRAM_BLOCKERS_BOT_TOKEN or TELEGRAM_BLOCKERS_CHAT_ID not set, skipping Telegram edit");
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/editMessageText`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "unknown");
    logger.error({ status: res.status, body: errorBody }, "Failed to edit Telegram blocker message");
    return false;
  }

  return true;
}

export function blockerService(db: Db) {
  return {
    async create(input: {
      taskId: string;
      agentId: string;
      summary: string;
      needs: string;
      context?: string;
      issueTitle?: string;
      issueIdentifier?: string;
      agentName?: string;
    }) {
      const blockerHash = computeBlockerHash(input.taskId, input.needs);
      const dedupCutoff = new Date(Date.now() - DEDUP_WINDOW_MS);

      // Check for dedup
      const existing = await db
        .select()
        .from(blockerNotifications)
        .where(
          and(
            eq(blockerNotifications.taskId, input.taskId),
            eq(blockerNotifications.blockerHash, blockerHash),
            isNull(blockerNotifications.resolvedAt),
            gt(blockerNotifications.postedAt, dedupCutoff),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return {
          ok: true,
          posted: false,
          notification: toJsonSafe(existing),
          duplicateOf: existing.id,
        };
      }

      // Scrub credentials from all text fields
      const scrubbedSummary = scrubCredentials(input.summary);
      const scrubbedNeeds = scrubCredentials(input.needs);
      const scrubbedContext = input.context ? scrubCredentials(input.context) : null;

      // Build the issue URL
      const issueIdentifier = input.issueIdentifier ?? input.taskId;
      const issueUrl = input.issueIdentifier ? buildIssueUrl(input.issueIdentifier) : null;
      const displayName = input.agentName ?? input.agentId;
      const titlePart = input.issueTitle ? ` ${input.issueTitle} ·` : "";

      // Format Telegram message
      const contextLine = scrubbedContext
        ? `\ncontext: ${truncateToLines(scrubbedContext, 3)}`
        : "";
      const taskLine = issueUrl ? `task:${titlePart} ${issueUrl}` : `task:${titlePart} ${issueIdentifier}`;
      const telegramText = [
        `\u{1F6A7} ${displayName} blocked on ${issueIdentifier}`,
        taskLine,
        `needs: ${scrubbedNeeds}`,
        ...(contextLine ? [contextLine.trim()] : []),
      ].join("\n");

      // Send to Telegram
      const telegramMsgId = await sendTelegramMessage(telegramText);

      // Upsert into DB
      const [notification] = await db
        .insert(blockerNotifications)
        .values({
          taskId: input.taskId,
          agentId: input.agentId,
          blockerHash,
          summary: scrubbedSummary,
          needs: scrubbedNeeds,
          context: scrubbedContext,
          telegramMsgId: telegramMsgId != null ? BigInt(telegramMsgId) : null,
        })
        .onConflictDoUpdate({
          target: [blockerNotifications.taskId, blockerNotifications.blockerHash],
          set: {
            summary: scrubbedSummary,
            needs: scrubbedNeeds,
            context: scrubbedContext,
            telegramMsgId: telegramMsgId != null ? BigInt(telegramMsgId) : null,
            postedAt: sql`NOW()`,
            resolvedAt: sql`NULL`,
          },
        })
        .returning();

      const telegramUrl = telegramMsgId != null
        ? `https://t.me/c/${process.env.TELEGRAM_BLOCKERS_CHAT_ID?.replace("-100", "")}/${telegramMsgId}`
        : null;

      return {
        ok: true,
        posted: true,
        notification: toJsonSafe(notification),
        telegramUrl,
      };
    },

    async resolve(notificationId: number) {
      const [existing] = await db
        .select()
        .from(blockerNotifications)
        .where(eq(blockerNotifications.id, notificationId));

      if (!existing) return null;

      if (existing.resolvedAt) {
        return { notification: toJsonSafe(existing), alreadyResolved: true };
      }

      // Edit Telegram message to resolved
      if (existing.telegramMsgId != null) {
        let agentName = existing.agentId;
        let issueIdentifier = existing.taskId;
        try {
          const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, existing.agentId));
          if (agent?.name) agentName = agent.name;
        } catch { /* non-critical */ }
        try {
          const [issue] = await db.select({ identifier: issues.identifier }).from(issues).where(eq(issues.id, existing.taskId));
          if (issue?.identifier) issueIdentifier = issue.identifier;
        } catch { /* non-critical */ }

        const issueUrl = issueIdentifier !== existing.taskId ? buildIssueUrl(issueIdentifier) : null;
        const taskLine = issueUrl ? `task: ${issueUrl}` : `task: ${issueIdentifier}`;
        const resolvedText = [
          `\u2705 Resolved: ${agentName} on ${issueIdentifier}`,
          taskLine,
          `was: ${existing.needs}`,
        ].join("\n");
        await editTelegramMessage(Number(existing.telegramMsgId), resolvedText);
      }

      const [updated] = await db
        .update(blockerNotifications)
        .set({ resolvedAt: sql`NOW()` })
        .where(eq(blockerNotifications.id, notificationId))
        .returning();

      return { notification: toJsonSafe(updated), alreadyResolved: false };
    },

    async resolveByTaskId(taskId: string) {
      // Find all unresolved notifications for this task
      const unresolved = await db
        .select()
        .from(blockerNotifications)
        .where(
          and(
            eq(blockerNotifications.taskId, taskId),
            isNull(blockerNotifications.resolvedAt),
          ),
        );

      const results = [];
      for (const notification of unresolved) {
        const result = await this.resolve(notification.id);
        if (result) results.push(result);
      }
      return results;
    },
  };
}
