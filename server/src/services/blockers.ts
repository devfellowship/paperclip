import { createHash } from "node:crypto";
import { eq, and, gt, isNull, sql } from "drizzle-orm";
import { blockerNotifications, agents, issues, companies } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { scrubCredentials } from "./blocker-credential-scrubber.js";
import { logger } from "../middleware/logger.js";

const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Base URL for the Paperclip UI, used when building clickable issue links in
 * blocker notifications. Falls back to the canonical public hostname. If the
 * env var is explicitly set to an empty string, no URL line is included.
 */
export function getPublicUrlBase(): string | null {
  const raw = process.env.PAPERCLIP_PUBLIC_URL;
  if (raw === undefined) {
    // No env configured: default to the canonical public host
    return "https://ppclip.tainanfidelis.com";
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  return trimmed;
}

/**
 * Build a URL to an issue in the Paperclip UI. Returns null if we don't have
 * enough info to produce a working link (no base, no prefix, or no identifier).
 *
 * URL shape: `${base}/${companyPrefix}/issues/${issueIdentifier}` — matches
 * the UI route `/:companyPrefix/issues/:id`.
 */
export function buildIssueUrl(
  base: string | null,
  companyPrefix: string | null | undefined,
  issueIdentifier: string | null | undefined,
): string | null {
  if (!base) return null;
  if (!companyPrefix || !issueIdentifier) return null;
  return `${base}/${companyPrefix}/issues/${issueIdentifier}`;
}

/** Render the Telegram text for a newly-posted blocker. */
export function formatBlockedMessage(input: {
  agentName: string;
  issueLabel: string;
  issueTitle?: string | null;
  issueUrl: string | null;
  needs: string;
  context?: string | null;
}): string {
  const lines: string[] = [
    `\u{1F6A7} ${input.agentName} blocked on ${input.issueLabel}`,
  ];
  if (input.issueUrl) {
    const titlePart = input.issueTitle ? ` ${input.issueTitle} \u00B7` : "";
    lines.push(`task:${titlePart} ${input.issueUrl}`);
  } else if (input.issueTitle) {
    lines.push(`task: ${input.issueTitle}`);
  }
  lines.push(`needs: ${input.needs}`);
  if (input.context) {
    lines.push(`context: ${input.context}`);
  }
  return lines.join("\n");
}

/** Render the Telegram text for a resolved blocker. */
export function formatResolvedMessage(input: {
  agentName: string;
  issueLabel: string;
  issueUrl: string | null;
  summary: string;
}): string {
  const lines: string[] = [
    `\u2705 Resolved: ${input.agentName} unblocked on ${input.issueLabel}`,
  ];
  if (input.issueUrl) {
    lines.push(input.issueUrl);
  }
  lines.push(`was: ${input.summary}`);
  return lines.join("\n");
}

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

/**
 * Look up human-friendly labels we use in Telegram messages. We avoid raw
 * UUIDs because they aren't actionable for the human reader.
 *
 * Falls back gracefully (agent name → short agent id suffix, issue identifier
 * → short task id suffix) so we always produce *some* reasonable text.
 */
async function loadMessageContext(
  db: Db,
  taskId: string,
  agentId: string,
): Promise<{
  agentName: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  companyPrefix: string | null;
}> {
  let agentName: string | null = null;
  let issueIdentifier: string | null = null;
  let issueTitle: string | null = null;
  let companyId: string | null = null;
  let companyPrefix: string | null = null;

  try {
    const row = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    agentName = row?.name ?? null;
  } catch (err) {
    logger.warn({ err, agentId }, "blockers: failed to resolve agent name");
  }

  try {
    const row = await db
      .select({
        identifier: issues.identifier,
        title: issues.title,
        companyId: issues.companyId,
      })
      .from(issues)
      .where(eq(issues.id, taskId))
      .then((rows) => rows[0] ?? null);
    if (row) {
      issueIdentifier = row.identifier ?? null;
      issueTitle = row.title ?? null;
      companyId = row.companyId;
    }
  } catch (err) {
    logger.warn({ err, taskId }, "blockers: failed to resolve issue identifier");
  }

  if (companyId) {
    try {
      const row = await db
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      companyPrefix = row?.issuePrefix ?? null;
    } catch (err) {
      logger.warn({ err, companyId }, "blockers: failed to resolve company prefix");
    }
  }

  return {
    agentName: agentName ?? "agent",
    issueIdentifier,
    issueTitle,
    companyPrefix,
  };
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

      // Look up human-friendly labels (agent name, DEV-### identifier, company prefix).
      // The caller may have supplied a title/identifier; prefer those but fall back to DB.
      const ctx = await loadMessageContext(db, input.taskId, input.agentId);
      const issueIdentifier = input.issueIdentifier ?? ctx.issueIdentifier;
      const issueTitle = input.issueTitle ?? ctx.issueTitle;
      const issueLabel = issueIdentifier ?? `task ${input.taskId.slice(0, 8)}`;

      const issueUrl = buildIssueUrl(getPublicUrlBase(), ctx.companyPrefix, issueIdentifier);

      const telegramText = formatBlockedMessage({
        agentName: ctx.agentName,
        issueLabel,
        issueTitle,
        issueUrl,
        needs: scrubbedNeeds,
        context: scrubbedContext ? truncateToLines(scrubbedContext, 3) : null,
      });

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
        const ctx = await loadMessageContext(db, existing.taskId, existing.agentId);
        const issueLabel = ctx.issueIdentifier ?? `task ${existing.taskId.slice(0, 8)}`;
        const issueUrl = buildIssueUrl(getPublicUrlBase(), ctx.companyPrefix, ctx.issueIdentifier);
        // Prefer the original blocker summary (short, human-written) over `needs`
        // which is often a verbose internal error dump.
        const summary = existing.summary || existing.needs;
        const resolvedText = formatResolvedMessage({
          agentName: ctx.agentName,
          issueLabel,
          issueUrl,
          summary,
        });
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
