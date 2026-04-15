/**
 * Unit tests for the fleet regression watcher (DEV-245, WS-1.a).
 *
 * Strategy: we avoid the embedded-postgres test harness and instead inject a
 * fake Drizzle-shaped db + a fake issueService into reconcileFailingPRs.
 * Tables are disambiguated by reference equality against the real drizzle
 * schema imports, which is stable across the suite.
 */

import { describe, expect, it, vi } from "vitest";
import { issueComments, issues } from "@paperclipai/db";
import {
  buildDedupMarker,
  buildDigest,
  buildIssueDescription,
  buildIssueTitle,
  computeDedupHash,
  isPRGreenInSnapshot,
  reconcileFailingPRs,
  type FailingPR,
  type FleetWatcherDeps,
} from "../services/fleet-regression-watcher.ts";

// ---------------------------------------------------------------------------
// Fake rows
// ---------------------------------------------------------------------------

interface FakeIssueRow {
  id: string;
  companyId: string;
  githubRepo: string | null;
  githubPrNumber: number | null;
  status: string;
  description: string | null;
}

interface FakeCommentRow {
  id: string;
  issueId: string;
  body: string;
}

const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

// ---------------------------------------------------------------------------
// Fake Drizzle query builder
// ---------------------------------------------------------------------------

function createFakeDb(state: {
  issues: FakeIssueRow[];
  comments: FakeCommentRow[];
}) {
  return {
    select(columns: Record<string, unknown>) {
      const columnKeys = Object.keys(columns);
      const selectionMeta = {
        wantsIssueCols:
          columnKeys.includes("githubRepo") || columnKeys.includes("githubPrNumber") || columnKeys.includes("status") || columnKeys.includes("description"),
      };
      let targetTable: unknown = null;
      let whereRepr: string = "";
      const builder: any = {
        from(table: unknown) {
          targetTable = table;
          return builder;
        },
        where(clause: unknown) {
          // Drizzle SQL chunks have a .queryChunks array of sub-expressions.
          // We serialize them via .toString() (avoids the circular ref that
          // JSON.stringify hits on PgColumn/PgTable objects).
          try {
            whereRepr = String(clause ?? "");
            // Also try to pull string/number literal values from nested
            // params for robust matching.
            const extractParams = (node: any): string[] => {
              if (node == null) return [];
              if (typeof node === "string" || typeof node === "number") return [String(node)];
              if (typeof node !== "object") return [];
              const out: string[] = [];
              if ("value" in node && (typeof node.value === "string" || typeof node.value === "number")) {
                out.push(String(node.value));
              }
              if (Array.isArray(node.queryChunks)) {
                for (const c of node.queryChunks) out.push(...extractParams(c));
              }
              if (Array.isArray(node.values)) {
                for (const c of node.values) out.push(...extractParams(c));
              }
              return out;
            };
            const params = extractParams(clause as any);
            whereRepr += "\n" + params.join("\n");
          } catch {
            whereRepr = "";
          }
          return builder;
        },
        limit(_n: number) {
          return Promise.resolve(resolveResults());
        },
        then(onFulfilled: (rows: unknown[]) => unknown) {
          return Promise.resolve(resolveResults()).then(onFulfilled);
        },
      };

      function resolveResults(): unknown[] {
        const isCommentsTable = targetTable === issueComments;
        const isIssuesTable = targetTable === issues;
        if (isCommentsTable) {
          // Comment idempotency lookup: filter by issueId + body substring
          // appearing in whereRepr.
          return state.comments.filter((c) => {
            const issueIdMatch = whereRepr.includes(c.issueId);
            const bodySub = whereRepr.includes("CI now passing")
              ? c.body.includes("CI now passing")
              : true;
            return issueIdMatch && bodySub;
          });
        }
        if (!isIssuesTable) return [];

        // Three issue-query shapes; disambiguate by whereRepr contents + columns.
        const markerMatch = whereRepr.match(/fleet-watcher-dedup:([a-f0-9]{8,32})/);
        if (markerMatch) {
          const marker = buildDedupMarker(markerMatch[1]!);
          return state.issues.filter(
            (i) =>
              (i.description ?? "").includes(marker) &&
              OPEN_STATUSES.includes(i.status),
          );
        }

        // Tracked-PR sweep asks for { id, githubRepo, githubPrNumber }
        const asksForSweepShape =
          columnKeys.includes("githubRepo") && columnKeys.includes("githubPrNumber");
        if (asksForSweepShape) {
          return state.issues.filter(
            (i) =>
              i.githubRepo != null &&
              i.githubPrNumber != null &&
              OPEN_STATUSES.includes(i.status),
          );
        }

        // (repo, pr, open) lookup — whereRepr should mention repo + pr.
        return state.issues.filter((i) => {
          if (!i.githubRepo || i.githubPrNumber == null) return false;
          if (!OPEN_STATUSES.includes(i.status)) return false;
          const repoHit = whereRepr.includes(i.githubRepo);
          const prHit = whereRepr.includes(String(i.githubPrNumber));
          return repoHit && prHit;
        });
      }

      // Keep selectionMeta referenced to avoid unused-var lint noise
      void selectionMeta;
      return builder;
    },
  };
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function makeDeps(opts: {
  failingPRs?: FailingPR[];
  existingIssues?: FakeIssueRow[];
  existingComments?: FakeCommentRow[];
}): FleetWatcherDeps & { __created: FakeIssueRow[]; __comments: FakeCommentRow[] } {
  const state = {
    issues: [...(opts.existingIssues ?? [])],
    comments: [...(opts.existingComments ?? [])],
  };
  const created: FakeIssueRow[] = [];
  const commentsAdded: FakeCommentRow[] = [];

  const fakeIssueService: FleetWatcherDeps["issues"] = {
    create: vi.fn(async (companyId: string, data: any) => {
      const row: FakeIssueRow = {
        id: `issue-${state.issues.length + 1}`,
        companyId,
        githubRepo: data.githubRepo ?? null,
        githubPrNumber: data.githubPrNumber ?? null,
        status: data.status ?? "todo",
        description: data.description ?? null,
      };
      state.issues.push(row);
      created.push(row);
      return row as any;
    }),
    addComment: vi.fn(async (issueId: string, body: string) => {
      const row: FakeCommentRow = {
        id: `comment-${state.comments.length + 1}`,
        issueId,
        body,
      };
      state.comments.push(row);
      commentsAdded.push(row);
      return row as any;
    }),
  };

  return {
    fetchFailingPRs: vi.fn(async () => opts.failingPRs ?? []),
    fetchFleetSnapshot: vi.fn(async () => null),
    issues: fakeIssueService,
    db: createFakeDb(state) as any,
    companyId: "company-1",
    now: () => new Date("2026-04-14T10:00:00Z"),
    __created: created,
    __comments: commentsAdded,
  };
}

// ---------------------------------------------------------------------------
// Pure-helper tests (no DB involved)
// ---------------------------------------------------------------------------

describe("fleet-regression-watcher helpers", () => {
  it("computeDedupHash is stable for same input and changes with checks", () => {
    const a: FailingPR = {
      repo: "devfellowship/dfl-hq",
      prNumber: 42,
      failedChecks: [{ name: "ci-build" }, { name: "ci-test" }],
    };
    const b: FailingPR = {
      repo: "devfellowship/dfl-hq",
      prNumber: 42,
      failedChecks: [{ name: "ci-test" }, { name: "ci-build" }],
    };
    const c: FailingPR = {
      repo: "devfellowship/dfl-hq",
      prNumber: 42,
      failedChecks: [{ name: "ci-test" }],
    };
    expect(computeDedupHash(a)).toBe(computeDedupHash(b));
    expect(computeDedupHash(a)).not.toBe(computeDedupHash(c));
  });

  it("buildIssueTitle and buildIssueDescription include the repo/pr + marker", () => {
    const pr: FailingPR = {
      repo: "devfellowship/dfl-hq",
      prNumber: 42,
      title: "Add caching",
      branch: "feat/caching",
      author: "@tainan",
      failedChecks: [{ name: "ci-build", htmlUrl: "https://gh/run" }],
    };
    const hash = computeDedupHash(pr);
    expect(buildIssueTitle(pr)).toBe("Fix failing CI: devfellowship/dfl-hq#42");
    const body = buildIssueDescription(pr, hash);
    expect(body).toContain("devfellowship/dfl-hq");
    expect(body).toContain("42");
    expect(body).toContain("ci-build");
    expect(body).toContain("Recovery procedure");
    expect(body).toContain(buildDedupMarker(hash));
  });

  it("buildDigest reports counts and pluralization", () => {
    const now = new Date("2026-04-14T10:00:00Z");
    const digest = buildDigest(
      [
        { repo: "devfellowship/dfl-hq", prNumber: 1 },
        { repo: "devfellowship/dfl-hq", prNumber: 2 },
        { repo: "devfellowship/dfl-learn", prNumber: 3 },
      ],
      1,
      now,
    );
    expect(digest).toContain("3 red PRs");
    expect(digest).toContain("2 repos");
    expect(digest).toContain("1 new ticket");
    expect(digest).toContain("2026-04-14");
  });

  it("isPRGreenInSnapshot finds a green PR and ignores failing ones", () => {
    const snap = {
      repos: [
        {
          fullName: "devfellowship/dfl-hq",
          openPRBranches: [
            { prNumber: 42, conclusion: "success", status: "completed" },
            { prNumber: 43, conclusion: "failure", status: "completed" },
          ],
        },
      ],
    };
    expect(isPRGreenInSnapshot(snap, "devfellowship/dfl-hq", 42)).toBe(true);
    expect(isPRGreenInSnapshot(snap, "devfellowship/dfl-hq", 43)).toBe(false);
    expect(isPRGreenInSnapshot(snap, "devfellowship/dfl-hq", 99)).toBe(false);
    expect(isPRGreenInSnapshot(null, "devfellowship/dfl-hq", 42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcileFailingPRs
// ---------------------------------------------------------------------------

describe("reconcileFailingPRs", () => {
  it("empty failing-prs response → 0 new issues", async () => {
    const deps = makeDeps({ failingPRs: [] });
    const result = await reconcileFailingPRs(deps);
    expect(result.opened).toBe(0);
    expect(result.resolved).toBe(0);
    expect(deps.__created).toHaveLength(0);
    expect(deps.issues.create).not.toHaveBeenCalled();
  });

  it("one failing PR with no existing issue → 1 new issue with correct githubRepo + githubPrNumber", async () => {
    const pr: FailingPR = {
      repo: "devfellowship/dfl-hq",
      prNumber: 42,
      title: "Add caching",
      branch: "feat/caching",
      author: "@tainan",
      failedChecks: [{ name: "ci-build", htmlUrl: "https://gh/run" }],
    };
    const deps = makeDeps({ failingPRs: [pr] });
    const result = await reconcileFailingPRs(deps);
    expect(result.opened).toBe(1);
    expect(deps.__created).toHaveLength(1);
    const created = deps.__created[0]!;
    expect(created.githubRepo).toBe("devfellowship/dfl-hq");
    expect(created.githubPrNumber).toBe(42);
    expect(created.status).toBe("todo");
    expect(created.description).toContain("devfellowship/dfl-hq");
    expect(created.description).toContain(buildDedupMarker(computeDedupHash(pr)));
  });

  it("running reconcile twice with same input → still only 1 issue (idempotent)", async () => {
    const pr: FailingPR = {
      repo: "devfellowship/dfl-hq",
      prNumber: 42,
      failedChecks: [{ name: "ci-build" }],
    };
    const deps = makeDeps({ failingPRs: [pr] });

    const first = await reconcileFailingPRs(deps);
    expect(first.opened).toBe(1);
    expect(deps.__created).toHaveLength(1);

    const second = await reconcileFailingPRs(deps);
    expect(second.opened).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    // No second issue created
    expect(deps.__created).toHaveLength(1);
  });
});
