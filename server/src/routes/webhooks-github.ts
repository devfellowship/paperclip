import crypto from "node:crypto";
import { Router } from "express";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { heartbeatService } from "../services/heartbeat.js";

type HeartbeatService = ReturnType<typeof heartbeatService>;

const LOG_TAIL_BYTES = 6 * 1024;
const RATE_LIMIT_REVERSIONS_PER_HOUR = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const CI_FAILURE_MARKER_PREFIX = "<!-- ci-failure v1 run=";

function verifyGitHubSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.slice(buf.length - maxBytes).toString("utf8");
}

async function fetchGitHubJson(url: string, token: string | undefined): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${url} returned ${res.status}: ${text}`);
  }
  return res.json();
}

async function fetchGitHubText(url: string, token: string | undefined): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    return "";
  }
  return res.text();
}

type FailedJobInfo = {
  name: string;
  failedStep: string | null;
  logsUrl: string;
};

async function fetchFailedJobInfo(
  owner: string,
  repo: string,
  runId: number,
  token: string | undefined,
): Promise<FailedJobInfo | null> {
  try {
    const jobsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`;
    const jobsData = await fetchGitHubJson(jobsUrl, token) as { jobs?: Array<{ conclusion: string; name: string; html_url: string; steps?: Array<{ conclusion: string; name: string }> }> };
    const failedJobs = (jobsData.jobs ?? []).filter((j) => j.conclusion === "failure");
    if (failedJobs.length === 0) return null;
    const job = failedJobs[0]!;
    const failedStep = job.steps?.find((s) => s.conclusion === "failure")?.name ?? null;
    return { name: job.name, failedStep, logsUrl: job.html_url };
  } catch (err) {
    logger.warn({ err }, "webhooks-github: failed to fetch job info");
    return null;
  }
}

async function fetchTruncatedLogs(
  owner: string,
  repo: string,
  runId: number,
  token: string | undefined,
): Promise<string> {
  try {
    const jobsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`;
    const jobsData = await fetchGitHubJson(jobsUrl, token) as { jobs?: Array<{ conclusion: string; id: number }> };
    const failedJob = (jobsData.jobs ?? []).find((j) => j.conclusion === "failure");
    if (!failedJob) return "";
    const logsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${failedJob.id}/logs`;
    const rawLogs = await fetchGitHubText(logsUrl, token);
    return tailBytes(rawLogs, LOG_TAIL_BYTES);
  } catch (err) {
    logger.warn({ err }, "webhooks-github: failed to fetch job logs");
    return "";
  }
}

export function webhooksGithubRoutes(db: Db, heartbeat: HeartbeatService): Router {
  const router = Router();

  router.post("/webhooks/github", async (req, res) => {
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.warn("webhooks-github: GITHUB_WEBHOOK_SECRET not configured, rejecting request");
      res.status(500).json({ error: "Webhook secret not configured" });
      return;
    }

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "Missing raw body" });
      return;
    }

    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const event = req.headers["x-github-event"] as string | undefined;
    if (event !== "workflow_run") {
      res.status(204).end();
      return;
    }

    const payload = req.body as {
      action?: string;
      workflow_run?: {
        id?: number;
        conclusion?: string;
        event?: string;
        html_url?: string;
        pull_requests?: Array<{ number?: number }>;
      };
      repository?: {
        full_name?: string;
        owner?: { login?: string };
        name?: string;
      };
    };

    if (
      payload.action !== "completed" ||
      payload.workflow_run?.conclusion !== "failure" ||
      payload.workflow_run?.event !== "pull_request"
    ) {
      res.status(204).end();
      return;
    }

    const repoFullName = payload.repository?.full_name;
    const prNumber = payload.workflow_run?.pull_requests?.[0]?.number;
    const runId = payload.workflow_run?.id;
    const runUrl = payload.workflow_run?.html_url ?? "";

    if (!repoFullName || !prNumber || !runId) {
      res.status(204).end();
      return;
    }

    // PR → Issue resolution
    const matchedIssue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.githubRepo, repoFullName),
          eq(issues.githubPrNumber, prNumber),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!matchedIssue) {
      res.status(204).end();
      return;
    }

    const { id: issueId, companyId, assigneeAgentId } = matchedIssue;

    // De-dup: check if we've already processed this run_id
    const ciMarker = `${CI_FAILURE_MARKER_PREFIX}${runId} -->`;
    const existingComment = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          sql`${issueComments.body} LIKE ${`%${ciMarker}%`}`,
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existingComment) {
      res.status(200).json({ ok: true, status: "deduped" });
      return;
    }

    // Rate limit: count reversions in the last hour
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
    const recentReversionCount = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          gte(issueComments.createdAt, windowStart),
          sql`${issueComments.body} LIKE ${"%" + CI_FAILURE_MARKER_PREFIX + "%"}`,
        ),
      )
      .then((rows) => rows.length);

    const rateLimited = recentReversionCount >= RATE_LIMIT_REVERSIONS_PER_HOUR;

    const githubToken = process.env.GITHUB_TOKEN;
    const [owner, repo] = repoFullName.split("/");

    // Fetch job info and logs
    const [jobInfo, truncatedLogs] = await Promise.all([
      fetchFailedJobInfo(owner!, repo!, runId, githubToken),
      fetchTruncatedLogs(owner!, repo!, runId, githubToken),
    ]);

    // Build structured comment body
    const commentLines: string[] = [
      `<!-- ci-failure v1 run=${runId} -->`,
      `**CI failure detected** on [${repoFullName}#${prNumber}](${runUrl})`,
      "",
      `- ci.repo: ${repoFullName}`,
      `- ci.pr: ${prNumber}`,
      `- ci.run_id: ${runId}`,
      `- ci.run_url: ${runUrl}`,
    ];

    if (jobInfo) {
      commentLines.push(`- ci.failed_job: ${jobInfo.name}`);
      if (jobInfo.failedStep) {
        commentLines.push(`- ci.failed_step: ${jobInfo.failedStep}`);
      }
    }

    if (rateLimited) {
      commentLines.push("", "> **CI flaky, human intervention needed** — rate limit exceeded (3 reversions/hour).");
    }

    if (truncatedLogs) {
      commentLines.push("", "```log", truncatedLogs.trim(), "```");
    }

    commentLines.push("<!-- /ci-failure -->");

    const commentBody = commentLines.join("\n");

    // Revert issue status (only if done or in_review) — skip if rate limited
    let reverted = false;
    if (!rateLimited && (matchedIssue.status === "done" || matchedIssue.status === "in_review")) {
      await db
        .update(issues)
        .set({ status: "in_progress", updatedAt: new Date() })
        .where(eq(issues.id, issueId));
      reverted = true;
    }

    // Insert comment
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: commentBody,
    });

    // Enqueue wakeup — skip if rate limited, no assignee, or agent is paused/archived
    if (!rateLimited && assigneeAgentId) {
      try {
        const agent = await db
          .select({ pausedAt: agents.pausedAt, status: agents.status })
          .from(agents)
          .where(eq(agents.id, assigneeAgentId))
          .then((rows) => rows[0] ?? null);

        const agentActive = agent && !agent.pausedAt && agent.status !== "archived";
        if (agentActive) {
          await heartbeat.wakeup(assigneeAgentId, {
            source: "automation",
            reason: "pr_check_failed",
            payload: {
              issueId,
              prNumber,
              runId,
              failedJob: jobInfo?.name ?? null,
              failedStep: jobInfo?.failedStep ?? null,
            },
          });
        } else {
          logger.info(
            { issueId, assigneeAgentId },
            "webhooks-github: skipping wakeup — agent is paused or archived",
          );
        }
      } catch (err) {
        logger.warn({ err, issueId, assigneeAgentId }, "webhooks-github: failed to enqueue wakeup");
      }
    }

    logger.info(
      { issueId, repoFullName, prNumber, runId, reverted, rateLimited },
      "webhooks-github: processed CI failure",
    );

    res.status(200).json({ ok: true, reverted, rateLimited });
  });

  return router;
}
