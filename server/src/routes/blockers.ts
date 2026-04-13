import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { blockerService } from "../services/blockers.js";
import { issueService } from "../services/index.js";
import { logger } from "../middleware/logger.js";

const createBlockerSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  summary: z.string().min(1),
  needs: z.string().min(1),
  context: z.string().optional(),
});

export function blockerRoutes(db: Db) {
  const router = Router();
  const svc = blockerService(db);
  const issueSvc = issueService(db);

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

  return router;
}
