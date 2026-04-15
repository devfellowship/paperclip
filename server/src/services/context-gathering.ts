/**
 * Pre-task context gathering (DEV-247, WS-2).
 *
 * Writes a `.paperclip-context.json` packet into an agent's execution
 * workspace just before `adapter.execute` is invoked, so agents start with
 * real state instead of burning LLM tool calls to re-discover it.
 *
 * Design goals:
 *   - NEVER THROW. Every external call (DB, HTTP, fs) is wrapped; on failure
 *     the corresponding section is omitted.
 *   - FAST. Budget <1s typical — runs on every agent spawn. Fleet-health HTTP
 *     call has a 5s hard timeout via AbortController.
 *   - SMALL. MVP packet only: issue, parent, children, recentRuns, fleetHealth.
 *
 * See WS-2 in /plans/20260414-harness-engineering-cost-shift-80-20.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export const CONTEXT_PACKET_FILENAME = ".paperclip-context.json";
export const CONTEXT_PACKET_SCHEMA_VERSION = 1;
const FLEET_HEALTH_SNAPSHOT_URL = "https://fleet-health.devfellowship.com/api/fleet";
const FLEET_HEALTH_TIMEOUT_MS = 5_000;
const RECENT_RUNS_LIMIT = 3;

export interface GatherContextOpts {
  issue: {
    id: string;
    companyId: string;
    /** Hint only — module re-reads from DB to stay self-consistent. */
    parentId?: string | null;
    /** Hint only — module re-reads from DB to stay self-consistent. */
    githubRepo?: string | null;
    /** Hint only — module re-reads from DB to stay self-consistent. */
    githubPrNumber?: number | null;
  };
  agent: {
    id: string;
    name: string;
    companyId: string;
  };
  workspaceCwd: string;
  db: Db;
  /** Test hook: override fleet-health fetch. */
  fleetHealthFetch?: (url: string, signal: AbortSignal) => Promise<unknown>;
  /** Test hook: override now(). */
  now?: () => Date;
}

export interface ContextPacketWriteResult {
  path: string;
  bytesWritten: number;
}

interface IssueRow {
  id: string;
  identifier: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  priority: string | null;
  parentId: string | null;
  githubRepo: string | null;
  githubPrNumber: number | null;
}

interface RecentRunRow {
  id: string;
  agentId: string | null;
  status: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface FleetSnapshotRepo {
  fullName?: string;
  name?: string;
  ciStatus?: string | null;
  conclusion?: string | null;
  openPRBranches?: Array<{
    prNumber?: number;
    number?: number;
    title?: string;
    conclusion?: string | null;
    ciStatus?: string | null;
    status?: string | null;
  }>;
}

interface FleetSnapshot {
  repos?: FleetSnapshotRepo[];
}

export async function gatherContextPacket(
  opts: GatherContextOpts,
): Promise<ContextPacketWriteResult | null> {
  const now = opts.now ?? (() => new Date());

  // Bail early if workspace dir isn't usable — caller will log+proceed.
  try {
    const stat = await fs.stat(opts.workspaceCwd);
    if (!stat.isDirectory()) {
      logger.warn(
        { workspaceCwd: opts.workspaceCwd },
        "context-gathering: workspaceCwd is not a directory; skipping",
      );
      return null;
    }
  } catch (err) {
    logger.warn(
      { workspaceCwd: opts.workspaceCwd, err: String(err) },
      "context-gathering: workspaceCwd missing; skipping",
    );
    return null;
  }

  // Load the issue first so downstream lookups use the canonical DB values
  // (parentId, githubRepo) rather than potentially stale caller hints.
  const issueRow = await safeLoadIssue(opts.db, opts.issue.companyId, opts.issue.id);
  const effectiveParentId = issueRow?.parentId ?? opts.issue.parentId ?? null;
  const effectiveGithubRepo = issueRow?.githubRepo ?? opts.issue.githubRepo ?? null;

  const [parentRow, childRows, recentRuns, fleetHealth] = await Promise.all([
    effectiveParentId
      ? safeLoadIssue(opts.db, opts.issue.companyId, effectiveParentId)
      : Promise.resolve(null),
    safeLoadChildren(opts.db, opts.issue.companyId, opts.issue.id),
    safeLoadRecentRuns(opts.db, opts.issue.companyId, opts.issue.id, opts.agent.id),
    effectiveGithubRepo
      ? safeLoadFleetHealth(effectiveGithubRepo, opts.fleetHealthFetch)
      : Promise.resolve(null),
  ]);

  const packet: Record<string, unknown> = {
    generatedAt: now().toISOString(),
    schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
    issue: issueRow
      ? {
          id: issueRow.id,
          title: issueRow.title ?? null,
          description: issueRow.description ?? null,
          status: issueRow.status ?? null,
          priority: issueRow.priority ?? null,
        }
      : { id: opts.issue.id, title: null, description: null, status: null, priority: null },
    parent: parentRow
      ? {
          id: parentRow.id,
          identifier: parentRow.identifier ?? null,
          title: parentRow.title ?? null,
        }
      : null,
    children: childRows,
    recentRuns: recentRuns,
    fleetHealth,
  };

  const serialized = JSON.stringify(packet, null, 2);
  const targetPath = path.join(opts.workspaceCwd, CONTEXT_PACKET_FILENAME);
  try {
    await fs.writeFile(targetPath, serialized, "utf8");
    return { path: targetPath, bytesWritten: Buffer.byteLength(serialized, "utf8") };
  } catch (err) {
    logger.warn(
      { targetPath, err: String(err) },
      "context-gathering: failed to write packet; skipping",
    );
    return null;
  }
}

async function safeLoadIssue(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<IssueRow | null> {
  try {
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
        parentId: issues.parentId,
        githubRepo: issues.githubRepo,
        githubPrNumber: issues.githubPrNumber,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .limit(1);
    return (rows[0] as IssueRow | undefined) ?? null;
  } catch (err) {
    logger.warn({ companyId, issueId, err: String(err) }, "context-gathering: load issue failed");
    return null;
  }
}

async function safeLoadChildren(
  db: Db,
  companyId: string,
  parentIssueId: string,
): Promise<Array<{ id: string; identifier: string | null; title: string | null; status: string | null }>> {
  try {
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.parentId, parentIssueId)))
      .limit(50);
    return rows.map((row) => ({
      id: row.id,
      identifier: row.identifier ?? null,
      title: row.title ?? null,
      status: row.status ?? null,
    }));
  } catch (err) {
    logger.warn(
      { companyId, parentIssueId, err: String(err) },
      "context-gathering: load children failed",
    );
    return [];
  }
}

async function safeLoadRecentRuns(
  db: Db,
  companyId: string,
  issueId: string,
  agentId: string,
): Promise<Array<{ id: string; agentNameKey: string | null; status: string | null; startedAt: string | null; finishedAt: string | null }>> {
  // Prefer runs scoped by (companyId, issueId) — heartbeatRuns stores the
  // issueId inside contextSnapshot JSONB. Fall back to agent-scoped runs if
  // the issue filter yields nothing.
  const toEntry = (row: RecentRunRow) => ({
    id: row.id,
    agentNameKey: row.agentId ?? null,
    status: row.status ?? null,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  });

  try {
    const issueScoped = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(RECENT_RUNS_LIMIT);

    if (issueScoped.length > 0) {
      return issueScoped.map((row) => toEntry(row as RecentRunRow));
    }

    const agentScoped = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(RECENT_RUNS_LIMIT);

    return agentScoped.map((row) => toEntry(row as RecentRunRow));
  } catch (err) {
    logger.warn(
      { companyId, issueId, agentId, err: String(err) },
      "context-gathering: load recent runs failed",
    );
    return [];
  }
}

async function safeLoadFleetHealth(
  githubRepo: string,
  fetchOverride?: GatherContextOpts["fleetHealthFetch"],
): Promise<
  | {
      repo: string;
      ciStatus: "passing" | "failing" | "none" | null;
      openPRBranches: Array<{ number: number; title: string | null; ciStatus: string | null }>;
    }
  | null
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLEET_HEALTH_TIMEOUT_MS);
  try {
    const doFetch = fetchOverride
      ? fetchOverride
      : async (url: string, signal: AbortSignal) => {
          const res = await fetch(url, {
            signal,
            headers: {
              accept: "application/json",
              "user-agent": "paperclip-context-gathering/1",
            },
          });
          if (!res.ok) {
            logger.warn({ url, status: res.status }, "context-gathering: fleet-health non-OK");
            return null;
          }
          return await res.json();
        };
    const json = (await doFetch(FLEET_HEALTH_SNAPSHOT_URL, controller.signal)) as FleetSnapshot | null;
    if (!json || !Array.isArray(json.repos)) return null;

    // Match by suffix so "devfellowship/dfl-reviews" matches a repo named "dfl-reviews".
    const target = githubRepo.toLowerCase();
    const match = json.repos.find((repo) => {
      const full = (repo.fullName ?? "").toLowerCase();
      const name = (repo.name ?? "").toLowerCase();
      return full === target || name === target || full.endsWith(`/${target}`);
    });

    if (!match) {
      return {
        repo: githubRepo,
        ciStatus: null,
        openPRBranches: [],
      };
    }

    const ciStatus = normalizeCiStatus(match.ciStatus ?? match.conclusion ?? null);
    const openPRBranches = (match.openPRBranches ?? []).map((branch) => {
      const number = typeof branch.number === "number"
        ? branch.number
        : typeof branch.prNumber === "number"
          ? branch.prNumber
          : 0;
      return {
        number,
        title: branch.title ?? null,
        ciStatus: normalizeCiStatusString(branch.ciStatus ?? branch.conclusion ?? branch.status ?? null),
      };
    });

    return {
      repo: githubRepo,
      ciStatus,
      openPRBranches,
    };
  } catch (err) {
    logger.warn(
      { githubRepo, err: String(err) },
      "context-gathering: fleet-health fetch failed",
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCiStatus(
  value: string | null,
): "passing" | "failing" | "none" | null {
  if (value == null) return null;
  const v = value.toLowerCase();
  if (v === "passing" || v === "success") return "passing";
  if (v === "failing" || v === "failure" || v === "failed") return "failing";
  if (v === "none" || v === "neutral" || v === "skipped") return "none";
  return null;
}

function normalizeCiStatusString(value: string | null): string | null {
  if (value == null) return null;
  return value;
}
