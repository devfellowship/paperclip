import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { blockerService } from "../services/blockers.js";
import { issueService } from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { secretsResolverService } from "../services/secrets-resolver.js";

const createBlockerSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  summary: z.string().min(1),
  needs: z.string().min(1),
  context: z.string().optional(),
});

const telegramWebhookSchema = z
  .object({
    update_id: z.number().optional(),
    message: z.unknown().optional(),
    edited_message: z.unknown().optional(),
    channel_post: z.unknown().optional(),
  })
  .passthrough();

export function blockerRoutes(db: Db) {
  const router = Router();
  const svc = blockerService(db);
  const issueSvc = issueService(db);
  const secretsResolver = secretsResolverService(db);

  router.post("/blockers", validate(createBlockerSchema), async (req, res) => {
    try {
      const { taskId, agentId, summary, needs, context } = req.body;

      // Try to fetch issue title and identifier for a richer Telegram message
      let issueTitle: string | undefined;
      let issueIdentifier: string | undefined;
      try {
        const issue = await issueSvc.getById(taskId);
        if (issue) {
          issueTitle = issue.title;
          issueIdentifier = issue.identifier ?? undefined;
        }
      } catch {
        // Non-critical — proceed without title
      }

      const result = await svc.create({
        taskId,
        agentId,
        summary,
        needs,
        context,
        issueTitle,
        issueIdentifier,
      });

      res.status(result.posted ? 201 : 200).json(result);
    } catch (err) {
      logger.error({ err }, "Failed to create blocker notification");
      res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  router.post("/blockers/:id/resolve", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ ok: false, error: "Invalid blocker ID" });
        return;
      }

      const result = await svc.resolve(id);
      if (!result) {
        res.status(404).json({ ok: false, error: "Blocker notification not found" });
        return;
      }

      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err }, "Failed to resolve blocker notification");
      res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  // DEV-252: Telegram webhook that closes the WS-4 credential loop. Register
  // with Telegram via:
  //   curl "https://api.telegram.org/bot$TOKEN/setWebhook?url=${PAPERCLIP_PUBLIC_URL}/api/telegram/blockers-webhook&secret_token=$TELEGRAM_WEBHOOK_SECRET&allowed_updates=[\"message\"]"
  // The secret_token is echoed back in the X-Telegram-Bot-Api-Secret-Token
  // header; we reject any request missing or mismatching it. Scope checks
  // (chat + thread) live in secretsResolverService so replay attacks targeted
  // at a different topic can't reach the resolver.
  router.post(
    "/telegram/blockers-webhook",
    validate(telegramWebhookSchema),
    async (req, res) => {
      try {
        const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
        if (!expectedSecret) {
          logger.warn(
            "telegram-webhook: TELEGRAM_WEBHOOK_SECRET not set, rejecting inbound update",
          );
          res.status(503).json({ ok: false, error: "Webhook not configured" });
          return;
        }
        const incoming =
          req.header("x-telegram-bot-api-secret-token") ??
          req.header("X-Telegram-Bot-Api-Secret-Token");
        if (incoming !== expectedSecret) {
          res.status(401).json({ ok: false, error: "Invalid secret token" });
          return;
        }

        const expectedChatId = process.env.TELEGRAM_BLOCKERS_CHAT_ID ?? null;
        const expectedThreadIdRaw = process.env.TELEGRAM_BLOCKERS_THREAD_ID;
        const expectedThreadId = expectedThreadIdRaw ? Number(expectedThreadIdRaw) : null;

        const result = await secretsResolver.handleTelegramUpdate({
          update: req.body,
          expectedChatId,
          expectedThreadId: Number.isFinite(expectedThreadId) ? expectedThreadId : null,
        });

        // Telegram expects 2xx on any accepted delivery, regardless of
        // whether we actually acted on the update. Always return 200 unless
        // the secret_token check failed.
        res.json({ ok: true, result });
      } catch (err) {
        logger.error({ err }, "Failed to handle telegram webhook update");
        // Return 200 anyway so Telegram doesn't retry indefinitely.
        res.json({ ok: false, error: "Internal server error" });
      }
    },
  );

  return router;
}
