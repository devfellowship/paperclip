/**
 * Fleet regression watcher (DEV-245, WS-1.a)
 *
 * Polls https://fleet-health.devfellowship.com/api/failing-prs every ~15 min
 * and reconciles the result against Paperclip issues for a target company:
 *
 *   - For every failing PR with no open issue (matched by githubRepo +
 *     githubPrNumber), open a `Fix failing CI: <repo>#<pr>` issue with
 *     `githubRepo` + `githubPrNumber` set so the existing PR-CI webhook and
 *     agent routing pick it up.
 *   - For every open issue whose PR is no longer in the failing list AND is
 *     confirmed green via /api/fleet, post a "CI now passing" comment. We
 *     deliberately do NOT auto-close — leave that to the agent or human.
 *
 * Idempotency: a dedup hash of `(repo, pr, checks)` is embedded in the issue
 * description as an HTML comment marker. Before creating a new issue we look
 * up both the (repo, pr) active-issue shape AND the hash marker, so running
 * reconcile twice in a row never creates duplicates.
 *
 * Wiring: registered in server/src/index.ts when
 * PAPERCLIP_FLEET_WATCHER_COMPANY_ID is set.
 *
 * Pure backend — no LLM, no agent code.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

// ---------------------------------------------------------------------------
// Types (mirror fleet-health API contract)
// ---------------------------------------------------------------------------

export interface FailingCheck {
  name: string;
  htmlUrl?: string | null;
}

export interface FailingPR {
  repo: string; // e.g. "devfellowship/dfl-hq"
  prNumber: number;
  title?: string;
  url?: string;
  author?: string;
  branch?: string;
  failedChecks?: FailingCheck[];
  updatedAt?: string;
}

export interface FleetSnapshotRepo {
  fullName?: string;
  name?: string;
  openPRBranches?: Array<{
    prNumber?: number;
    conclusion?: string | null;
    status?: string | null;
    url?: string | null;
    htmlUrl?: string | null;
  }>;
}

export interface FleetSnapshot {
  repos?: FleetSnapshotRepo[];
}

export interface ReconcileSummary {
  opened: number;
  resolved: number;
  skipped: number;
  digest: string;
}

// ---------------------------------------------------------------------------
// Deps injection (swappable for tests)
// ---------------------------------------------------------------------------

export interface FleetWatcherDeps {
  fetchFailingPRs: () => Promise<FailingPR[]>;
  fetchFleetSnapshot: () => Promise<FleetSnapshot | null>;
  /** Subset of issueService shape we need. */
  issues: Pick<ReturnType<typeof issueService>, "create" | "addComment">;
  db: Db;
  companyId: string;
  /** Optional: notify via Telegram or other channel when digest ready. */
  postDigest?: (digest: string) => Promise<void>;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FLEET_HEALTH_FAILING_PRS_URL =
  "https://fleet-health.devfellowship.com/api/failing-prs";
export const FLEET_HEALTH_SNAPSHOT_URL =
  "https://fleet-health.devfellowship.com/api/fleet";

const DEDUP_MARKER_PREFIX = "<!-- fleet-watcher-dedup:";
const DEDUP_MARKER_SUFFIX = " -->";
/** Non-terminal statuses — we only match open/in-flight work. */
const OPEN_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
] as const;

// ---------------------------------------------------------------------------
// Assignee routing
// ---------------------------------------------------------------------------

const INFRA_REPOS = new Set([
  "dfl-ci",
  "dfl-harness",
  "dfl-infra",
  "dfl-fleet-health",
  "dfl-sandbox-manager",
]);

const DEFAULT_ASSIGNEE_MAP: Record<string, string> = {
  infra: "52b8e0f6-a267-40ed-9664-d8917f4495b5",   // dfl-rollout-ops
  app:   "bb604576-2eb5-4fd3-9088-a48e469e6432",     // dfl-single-repo-impl
};

function loadAssigneeMap(): Record<string, string> {
  const raw = process.env.FLEET_WATCHER_ASSIGNEE_MAP_JSON;
  if (!raw) return DEFAULT_ASSIGNEE_MAP;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    logger.warn("fleet-watcher: invalid FLEET_WATCHER_ASSIGNEE_MAP_JSON, using defaults");
    return DEFAULT_ASSIGNEE_MAP;
  }
}

export function resolveAssignee(repoFullName: string): string | undefined {
  const map = loadAssigneeMap();
  const shortName = repoFullName.includes("/")
    ? repoFullName.split("/").pop()!
    : repoFullName;

  if (!shortName.startsWith("dfl-")) return undefined;

  if (INFRA_REPOS.has(shortName)) return map.infra;
  return map.app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function computeDedupHash(pr: FailingPR): string {
  const checks = (pr.failedChecks ?? [])
    .map((c) => c.name)
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .sort();
  const payload = `${pr.repo}|${pr.prNumber}|${checks.join(",")}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function buildDedupMarker(hash: string): string {
  return `${DEDUP_MARKER_PREFIX}${hash}${DEDUP_MARKER_SUFFIX}`;
}

export function buildIssueTitle(pr: FailingPR): string {
  return `Fix failing CI: ${pr.repo}#${pr.prNumber}`;
}

export function buildIssueDescription(pr: FailingPR, dedupHash: string): string {
  const checks = pr.failedChecks ?? [];
  const checkLines = checks.length
    ? checks
        .map((c) => {
          const url = c.htmlUrl ? ` (${c.htmlUrl})` : "";
          return `- ${c.name}${url}`;
        })
        .join("\n")
    : "- (none reported)";
  const prUrl = pr.url ?? `https://github.com/${pr.repo}/pull/${pr.prNumber}`;
  const branch = pr.branch ?? "(unknown)";
  const author = pr.author ?? "(unknown)";
  const title = pr.title ? pr.title.trim() : "(no title)";

  return [
    `Auto-opened by the fleet regression watcher (DEV-245).`,
    ``,
    `**PR**: ${prUrl}`,
    `**Repo**: ${pr.repo}`,
    `**PR #**: ${pr.prNumber}`,
    `**Branch**: ${branch}`,
    `**Author**: ${author}`,
    `**Title**: ${title}`,
    ``,
    `## Failing checks`,
    checkLines,
    ``,
    `## Recovery procedure`,
    `1. Fetch the PR branch locally: \`git fetch origin ${branch} && git checkout ${branch}\`.`,
    `2. Re-run the failing checks locally (see the URLs above for the exact command/workflow).`,
    `3. Fix the regression, push a new commit, and wait for CI to rerun.`,
    `4. When fleet-health flips the PR to green this issue will receive a comment; close it after verifying the PR merges cleanly.`,
    ``,
    `Source: ${FLEET_HEALTH_FAILING_PRS_URL}`,
    ``,
    buildDedupMarker(dedupHash),
  ].join("\n");
}

export function buildDigest(
  failingPRs: FailingPR[],
  opened: number,
  now: Date,
): string {
  const red = failingPRs.length;
  const repos = new Set(failingPRs.map((p) => p.repo)).size;
  const iso = now.toISOString().slice(0, 10);
  return `[fleet-watcher ${iso}] ${red} red PR${red === 1 ? "" : "s"}, ${repos} repo${repos === 1 ? "" : "s"} affected, ${opened} new ticket${opened === 1 ? "" : "s"} opened.`;
}

// ---------------------------------------------------------------------------
// Default fetch impls
// ---------------------------------------------------------------------------

async function defaultFetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "paperclip-fleet-watcher/1" },
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "fleet-watcher: non-OK response");
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, url }, "fleet-watcher: fetch failed");
    return null;
  }
}

export async function fetchFailingPRs(): Promise<FailingPR[]> {
  const data = await defaultFetchJson<FailingPR[] | { prs?: FailingPR[]; total?: number }>(
    FLEET_HEALTH_FAILING_PRS_URL,
  );
  // Accept both bare array and { prs: [...] } envelope shapes
  const rows: unknown[] = Array.isArray(data)
    ? data
    : (data as any)?.prs != null && Array.isArray((data as any).prs)
      ? (data as any).prs
      : [];
  if (rows.length === 0 && data != null && typeof data === "object" && !Array.isArray(data)) {
    const total = (data as any).total;
    if (typeof total === "number" && total > 0) {
      logger.warn(
        { url: FLEET_HEALTH_FAILING_PRS_URL, envelopeTotal: total, extractedCount: 0 },
        "fleet-watcher: envelope total > 0 but extracted 0 PRs — possible shape drift",
      );
    }
  }
  return rows.filter(
    (row): row is FailingPR =>
      row != null &&
      typeof row === "object" &&
      typeof (row as any).repo === "string" &&
      typeof (row as any).prNumber === "number",
  );
}

export async function fetchFleetSnapshot(): Promise<FleetSnapshot | null> {
  return defaultFetchJson<FleetSnapshot>(FLEET_HEALTH_SNAPSHOT_URL);
}

// ---------------------------------------------------------------------------
// Snapshot lookup: is the PR green right now?
// ---------------------------------------------------------------------------

export function isPRGreenInSnapshot(
  snapshot: FleetSnapshot | null,
  repoFullName: string,
  prNumber: number,
): boolean {
  if (!snapshot?.repos) return false;
  for (const repo of snapshot.repos) {
    const name = repo.fullName ?? repo.name ?? "";
    if (name !== repoFullName) continue;
    for (const pr of repo.openPRBranches ?? []) {
      if (pr.prNumber !== prNumber) continue;
      const conclusion = (pr.conclusion ?? "").toLowerCase();
      const status = (pr.status ?? "").toLowerCase();
      // Green = conclusion "success" or ("completed" with no failure)
      if (conclusion === "success") return true;
      if (conclusion === "" && status === "completed") return true;
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main reconcile
// ---------------------------------------------------------------------------

export async function reconcileFailingPRs(
  deps: FleetWatcherDeps,
): Promise<ReconcileSummary> {
  const now = deps.now?.() ?? new Date();
  const failingPRs = await deps.fetchFailingPRs();

  let opened = 0;
  let skipped = 0;

  // --------------------------------------------------------------
  // Phase 1: ensure every failing PR has an open issue
  // --------------------------------------------------------------
  for (const pr of failingPRs) {
    try {
      const existing = await deps.db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, deps.companyId),
            eq(issues.githubRepo, pr.repo),
            eq(issues.githubPrNumber, pr.prNumber),
            inArray(issues.status, OPEN_ISSUE_STATUSES as unknown as string[]),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const dedupHash = computeDedupHash(pr);
      const marker = buildDedupMarker(dedupHash);
      // Dedup fallback: description contains the same hash marker (handles
      // races where githubRepo/githubPrNumber weren't populated for some
      // reason, e.g. a human opened a ticket manually without those fields).
      const markerHit = await deps.db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, deps.companyId),
            like(issues.description, `%${marker}%`),
            inArray(issues.status, OPEN_ISSUE_STATUSES as unknown as string[]),
          ),
        )
        .limit(1);
      if (markerHit.length > 0) {
        skipped++;
        continue;
      }

      const title = buildIssueTitle(pr);
      const description = buildIssueDescription(pr, dedupHash);
      const assigneeAgentId = resolveAssignee(pr.repo);

      await deps.issues.create(deps.companyId, {
        title,
        description,
        status: "todo",
        priority: "high",
        assigneeAgentId,
        githubRepo: pr.repo,
        githubPrNumber: pr.prNumber,
        originKind: "fleet_watcher",
        originId: `${pr.repo}#${pr.prNumber}`,
      } as Parameters<typeof deps.issues.create>[1]);
      opened++;
    } catch (err) {
      logger.error({ err, pr: `${pr.repo}#${pr.prNumber}` }, "fleet-watcher: failed to open issue");
    }
  }

  // --------------------------------------------------------------
  // Phase 2: PRs that were tracked and are no longer failing →
  // verify green via snapshot, post a "CI now passing" comment.
  // --------------------------------------------------------------
  let resolved = 0;
  const failingKey = new Set(failingPRs.map((p) => `${p.repo}#${p.prNumber}`));

  const openTracked = await deps.db
    .select({
      id: issues.id,
      githubRepo: issues.githubRepo,
      githubPrNumber: issues.githubPrNumber,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, deps.companyId),
        isNotNull(issues.githubRepo),
        isNotNull(issues.githubPrNumber),
        inArray(issues.status, OPEN_ISSUE_STATUSES as unknown as string[]),
      ),
    );

  const needsSnapshot = openTracked.filter((row) => {
    if (!row.githubRepo || row.githubPrNumber == null) return false;
    return !failingKey.has(`${row.githubRepo}#${row.githubPrNumber}`);
  });

  if (needsSnapshot.length > 0) {
    const snapshot = await deps.fetchFleetSnapshot();
    for (const row of needsSnapshot) {
      if (!row.githubRepo || row.githubPrNumber == null) continue;
      if (!isPRGreenInSnapshot(snapshot, row.githubRepo, row.githubPrNumber)) {
        continue;
      }
      // Idempotency: don't post the same "CI now passing" comment repeatedly.
      const already = await deps.db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, row.id),
            like(issueComments.body, "%CI now passing — see fleet-health.%"),
          ),
        )
        .limit(1);
      if (already.length > 0) continue;

      try {
        await deps.issues.addComment(
          row.id,
          `CI now passing — see fleet-health. (auto-posted by fleet regression watcher)`,
          { agentId: undefined, userId: undefined, runId: null },
        );
        resolved++;
      } catch (err) {
        logger.warn({ err, issueId: row.id }, "fleet-watcher: failed to post CI-green comment");
      }
    }
  }

  const digest = buildDigest(failingPRs, opened, now);
  return { opened, resolved, skipped, digest };
}

// ---------------------------------------------------------------------------
// Scheduler wrapper
// ---------------------------------------------------------------------------

export interface FleetWatcherSchedulerOptions {
  /** How often to run reconcile. Defaults to 15 minutes. */
  reconcileIntervalMs?: number;
  /** Hour in UTC for daily digest (default: 12 = 9am BRT, UTC-3). */
  digestHourUtc?: number;
}

export interface FleetWatcherSchedulerState {
  lastDigestDate: string | null; // YYYY-MM-DD
  inFlight: boolean;
}

/**
 * Build the interval callback. Exposed so callers can unit-test ticking or
 * drive it from other schedulers — the index.ts wiring calls this via a plain
 * setInterval.
 */
export function createFleetWatcherTick(
  deps: FleetWatcherDeps,
  options: FleetWatcherSchedulerOptions = {},
): {
  state: FleetWatcherSchedulerState;
  tick: () => Promise<void>;
} {
  const state: FleetWatcherSchedulerState = {
    lastDigestDate: null,
    inFlight: false,
  };
  const digestHour = options.digestHourUtc ?? 12;

  const tick = async () => {
    if (state.inFlight) {
      logger.debug("fleet-watcher: previous tick still in-flight, skipping");
      return;
    }
    state.inFlight = true;
    try {
      const now = deps.now?.() ?? new Date();
      const result = await reconcileFailingPRs(deps);
      if (result.opened > 0 || result.resolved > 0) {
        logger.info(
          { opened: result.opened, resolved: result.resolved, skipped: result.skipped },
          "fleet-watcher: reconcile complete",
        );
      }

      // Daily digest gate: once per UTC day, only at/after digestHour.
      const todayKey = now.toISOString().slice(0, 10);
      const nowHour = now.getUTCHours();
      if (
        deps.postDigest &&
        nowHour >= digestHour &&
        state.lastDigestDate !== todayKey
      ) {
        try {
          await deps.postDigest(result.digest);
          state.lastDigestDate = todayKey;
        } catch (err) {
          logger.warn({ err }, "fleet-watcher: postDigest failed");
        }
      }
    } catch (err) {
      logger.error({ err }, "fleet-watcher: tick failed");
    } finally {
      state.inFlight = false;
    }
  };

  return { state, tick };
}
