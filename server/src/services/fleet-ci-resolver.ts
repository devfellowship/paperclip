/**
 * fleet-ci-resolver (DEV-504)
 *
 * Standalone resolver for determining whether a "fix failing CI" issue is
 * still actionable.  Probes the GitHub API directly (not the fleet-health
 * snapshot) so it can be used in contexts where the snapshot is unavailable,
 * and caches results for 5 minutes to stay well inside rate limits on a
 * fleet of 14+ repos.
 *
 * Auto-close criteria (ADR-1):
 *   (a) PR merged    → resolved: true, reason: "pr-merged"
 *   (b) PR closed    → resolved: true, reason: "pr-closed"
 *   (c) main ≥3 consecutive green runs → resolved: true, reason: "main-green-N-consecutive"
 *
 * Usage:
 *   const result = await resolveCiIssue(issue, githubToken);
 *   if (result.resolved) {
 *     await cancelIssue(issue.id, result.reason!);
 *   }
 */

export const RESOLVE_GREEN_STREAK_THRESHOLD = 3;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CiIssueRef {
  /** Full repo name, e.g. "devfellowship/dfl-hq". */
  githubRepo: string | null;
  /**
   * PR number for PR-CI issues.  Null/undefined for main-branch CI issues.
   */
  githubPrNumber?: number | null;
}

export interface ResolveResult {
  resolved: boolean;
  /** Machine-readable reason, present only when resolved === true. */
  reason?: string;
}

interface GitHubPR {
  state: string;
  merged: boolean;
  merged_at?: string | null;
}

interface GitHubWorkflowRun {
  status: string;
  conclusion: string | null;
}

interface GitHubRunsResponse {
  workflow_runs: GitHubWorkflowRun[];
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: ResolveResult;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

function cacheKey(repo: string, prNumber: number | null | undefined): string {
  return `${repo}#${prNumber ?? "main"}`;
}

/** Exposed for tests — clears all cached entries. */
export function _clearResolverCache(): void {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function ghHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchPR(
  repo: string,
  prNumber: number,
  token: string,
): Promise<GitHubPR | null> {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub PR fetch failed: ${res.status} ${url}`);
  return (await res.json()) as GitHubPR;
}

async function fetchMainRuns(
  repo: string,
  token: string,
  perPage = 10,
): Promise<GitHubWorkflowRun[]> {
  const url = `https://api.github.com/repos/${repo}/actions/runs?branch=main&per_page=${perPage}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub runs fetch failed: ${res.status} ${url}`);
  const data = (await res.json()) as GitHubRunsResponse;
  return data.workflow_runs ?? [];
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

/**
 * Determines whether a CI issue is still actionable by probing GitHub
 * directly.  Results are cached for 5 minutes per (repo, pr) pair.
 *
 * @param issue  Issue metadata with at least githubRepo set.
 * @param token  GitHub personal access token (read-only scope sufficient).
 * @returns      { resolved, reason } — reason is set only when resolved.
 */
export async function resolveCiIssue(
  issue: CiIssueRef,
  token: string,
): Promise<ResolveResult> {
  const { githubRepo, githubPrNumber } = issue;

  if (!githubRepo) return { resolved: false };

  const key = cacheKey(githubRepo, githubPrNumber);
  const cached = _cache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  let result: ResolveResult;

  try {
    if (githubPrNumber != null) {
      result = await resolvePrIssue(githubRepo, githubPrNumber, token);
    } else {
      result = await resolveMainBranchIssue(githubRepo, token);
    }
  } catch {
    // Network / transient errors: do not cache, let the next tick retry.
    return { resolved: false };
  }

  _cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

async function resolvePrIssue(
  repo: string,
  prNumber: number,
  token: string,
): Promise<ResolveResult> {
  const pr = await fetchPR(repo, prNumber, token);

  // 404 → PR deleted (repo deleted, or force-pushed over it) — treat as closed.
  if (pr === null) {
    return { resolved: true, reason: "pr-not-found" };
  }
  if (pr.merged) {
    return { resolved: true, reason: "pr-merged" };
  }
  if (pr.state === "closed") {
    return { resolved: true, reason: "pr-closed" };
  }
  return { resolved: false };
}

async function resolveMainBranchIssue(
  repo: string,
  token: string,
): Promise<ResolveResult> {
  const runs = await fetchMainRuns(repo, token);

  // Count consecutive completed+success runs from the most recent.
  let consecutive = 0;
  for (const run of runs) {
    if (run.status !== "completed") break;
    if (run.conclusion !== "success") break;
    consecutive++;
  }

  if (consecutive >= RESOLVE_GREEN_STREAK_THRESHOLD) {
    return { resolved: true, reason: `main-green-${consecutive}-consecutive` };
  }
  return { resolved: false };
}
