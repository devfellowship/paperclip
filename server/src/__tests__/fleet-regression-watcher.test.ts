/**
 * Unit tests for the fleet regression watcher (DEV-245, WS-1.a, DEV-419).
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
  buildMainBranchIssueDescription,
  buildMainBranchIssueTitle,
  computeDedupHash,
  computeMainBranchDedupHash,
  extractFailingMainBranches,
  isMainBranchGreenInSnapshot,
  isPRGreenInSnapshot,
  reconcileFailingPRs,
  resolveAssignee,
  type FailingMainBranch,
  type FailingPR,
  type FleetSnapshot,
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
  originKind: string | null;
  originId: string | null;
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
      let targetTable: unknown = null;
      let whereRepr: string = "";
      const builder: any = {
        from(table: unknown) {
          targetTable = table;
          return builder;
        },
        where(clause: unknown) {
          try {
            whereRepr = String(clause ?? "");
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
          return state.comments.filter((c) => {
            const issueIdMatch = whereRepr.includes(c.issueId);
            const bodySub = whereRepr.includes("CI now passing")
              ? c.body.includes("CI now passing")
              : true;
            return issueIdMatch && bodySub;
          });
        }
        if (!isIssuesTable) return [];

        // Dedup marker lookup
        const markerMatch = whereRepr.match(/fleet-watcher-dedup:([a-f0-9]{8,32})/);
        if (markerMatch) {
          const marker = buildDedupMarker(markerMatch[1]!);
          return state.issues.filter(
            (i) =>
              (i.description ?? "").includes(marker) &&
              OPEN_STATUSES.includes(i.status),
          );
        }

        // Phase 2b: main-branch resolution sweep (originKind + originId LIKE %#main + NULL prNumber)
        const isMainBranchSweep =
          whereRepr.includes("fleet_watcher") &&
          whereRepr.includes("#main") &&
          !columnKeys.includes("githubPrNumber");
        if (isMainBranchSweep) {
          return state.issues.filter(
            (i) =>
              i.githubRepo != null &&
              i.githubPrNumber == null &&
              i.originKind === "fleet_watcher" &&
              (i.originId ?? "").endsWith("#main") &&
              OPEN_STATUSES.includes(i.status),
          );
        }

        // Tracked-PR sweep (Phase 2): { id, githubRepo, githubPrNumber } with isNotNull
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

        // Phase 1b: main-branch dedup by (repo, NULL prNumber)
        // Detect: whereRepr has a repo name but the query uses isNull on prNumber
        // We check if the query is looking for NULL prNumber by checking for
        // issues with null prNumber matching the repo
        const isMainBranchDedup = state.issues.some(
          (i) => i.githubPrNumber == null && i.githubRepo != null &&
            whereRepr.includes(i.githubRepo),
        );
        if (isMainBranchDedup) {
          return state.issues.filter((i) => {
            if (!i.githubRepo) return false;
            if (i.githubPrNumber != null) return false;
            if (!OPEN_STATUSES.includes(i.status)) return false;
            return whereRepr.includes(i.githubRepo);
          });
        }

        // (repo, pr, open) lookup — Phase 1 PR dedup
        return state.issues.filter((i) => {
          if (!i.githubRepo || i.githubPrNumber == null) return false;
          if (!OPEN_STATUSES.includes(i.status)) return false;
          const repoHit = whereRepr.includes(i.githubRepo);
          const prHit = whereRepr.includes(String(i.githubPrNumber));
          return repoHit && prHit;
        });
      }

      return builder;
    },
  };
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function makeDeps(opts: {
  failingPRs?: FailingPR[];
  fleetSnapshot?: FleetSnapshot | null;
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
        originKind: data.originKind ?? null,
        originId: data.originId ?? null,
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
    fetchFleetSnapshot: vi.fn(async () => opts.fleetSnapshot ?? null),
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

  it("buildDigest includes main-branch count when provided", () => {
    const now = new Date("2026-04-14T10:00:00Z");
    const digest = buildDigest(
      [{ repo: "devfellowship/dfl-hq", prNumber: 1 }],
      1,
      now,
      3,
      2,
    );
    expect(digest).toContain("1 red PR");
    expect(digest).toContain("3 red main branches");
    expect(digest).toContain("3 new tickets");
  });

  it("buildDigest omits main-branch part when zero", () => {
    const now = new Date("2026-04-14T10:00:00Z");
    const digest = buildDigest(
      [{ repo: "devfellowship/dfl-hq", prNumber: 1 }],
      1,
      now,
      0,
      0,
    );
    expect(digest).not.toContain("main branch");
    expect(digest).toContain("1 new ticket");
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
// Main-branch helper tests
// ---------------------------------------------------------------------------

describe("main-branch helpers", () => {
  it("computeMainBranchDedupHash is stable and differs from PR hash", () => {
    const h1 = computeMainBranchDedupHash("devfellowship/dfl-hq");
    const h2 = computeMainBranchDedupHash("devfellowship/dfl-hq");
    const h3 = computeMainBranchDedupHash("devfellowship/dfl-learn");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    // Must differ from PR dedup hash for same repo
    const prHash = computeDedupHash({ repo: "devfellowship/dfl-hq", prNumber: 0 });
    expect(h1).not.toBe(prHash);
  });

  it("buildMainBranchIssueTitle formats correctly", () => {
    expect(buildMainBranchIssueTitle("devfellowship/dfl-hq")).toBe(
      "Fix failing CI: devfellowship/dfl-hq main branch",
    );
  });

  it("buildMainBranchIssueDescription includes repo + dedup marker", () => {
    const mb: FailingMainBranch = {
      repo: "devfellowship/dfl-hq",
      ciWorkflowName: "Vercel Deploy",
      defaultBranch: "main",
    };
    const hash = computeMainBranchDedupHash(mb.repo);
    const body = buildMainBranchIssueDescription(mb, hash);
    expect(body).toContain("devfellowship/dfl-hq");
    expect(body).toContain("Vercel Deploy");
    expect(body).toContain("main (default)");
    expect(body).toContain("Recovery procedure");
    expect(body).toContain(buildDedupMarker(hash));
  });

  it("extractFailingMainBranches filters to ciStatus=failing", () => {
    const snap: FleetSnapshot = {
      repos: [
        { fullName: "devfellowship/dfl-hq", ciStatus: "failing", ciWorkflowName: "CI" },
        { fullName: "devfellowship/dfl-learn", ciStatus: "passing" },
        { fullName: "devfellowship/dfl-iam", ciStatus: "failing", ciWorkflowName: "Vercel" },
        { ciStatus: "failing" }, // no name — should be excluded
      ],
    };
    const result = extractFailingMainBranches(snap);
    expect(result).toHaveLength(2);
    expect(result[0]!.repo).toBe("devfellowship/dfl-hq");
    expect(result[1]!.repo).toBe("devfellowship/dfl-iam");
  });

  it("extractFailingMainBranches returns empty for null snapshot", () => {
    expect(extractFailingMainBranches(null)).toHaveLength(0);
  });

  it("isMainBranchGreenInSnapshot checks ciStatus=passing", () => {
    const snap: FleetSnapshot = {
      repos: [
        { fullName: "devfellowship/dfl-hq", ciStatus: "passing" },
        { fullName: "devfellowship/dfl-learn", ciStatus: "failing" },
        { fullName: "devfellowship/dfl-iam", ciStatus: "none" },
      ],
    };
    expect(isMainBranchGreenInSnapshot(snap, "devfellowship/dfl-hq")).toBe(true);
    expect(isMainBranchGreenInSnapshot(snap, "devfellowship/dfl-learn")).toBe(false);
    expect(isMainBranchGreenInSnapshot(snap, "devfellowship/dfl-iam")).toBe(false);
    expect(isMainBranchGreenInSnapshot(snap, "devfellowship/dfl-unknown")).toBe(false);
    expect(isMainBranchGreenInSnapshot(null, "devfellowship/dfl-hq")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcileFailingPRs — PR tests
// ---------------------------------------------------------------------------

describe("reconcileFailingPRs", () => {
  it("empty failing-prs response → 0 new issues", async () => {
    const deps = makeDeps({ failingPRs: [] });
    const result = await reconcileFailingPRs(deps);
    expect(result.opened).toBe(0);
    expect(result.resolved).toBe(0);
    expect(result.mainBranchOpened).toBe(0);
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
    expect(deps.__created).toHaveLength(1);
  });

  it("new issue gets assigneeAgentId from repo routing and priority high", async () => {
    const infraPr: FailingPR = {
      repo: "devfellowship/dfl-ci",
      prNumber: 10,
      failedChecks: [{ name: "build" }],
    };
    const appPr: FailingPR = {
      repo: "devfellowship/dfl-learn",
      prNumber: 20,
      failedChecks: [{ name: "test" }],
    };
    const deps = makeDeps({ failingPRs: [infraPr, appPr] });
    await reconcileFailingPRs(deps);

    expect(deps.issues.create).toHaveBeenCalledTimes(2);
    const calls = (deps.issues.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toMatchObject({
      assigneeAgentId: "52b8e0f6-a267-40ed-9664-d8917f4495b5",
      priority: "high",
    });
    expect(calls[1][1]).toMatchObject({
      assigneeAgentId: "bb604576-2eb5-4fd3-9088-a48e469e6432",
      priority: "high",
    });
  });
});

// ---------------------------------------------------------------------------
// reconcileFailingPRs — main-branch tests (DEV-419)
// ---------------------------------------------------------------------------

describe("reconcileFailingPRs — main-branch tracking", () => {
  it("failing main branch creates issue with correct title + assignee", async () => {
    const snapshot: FleetSnapshot = {
      repos: [
        { fullName: "devfellowship/dfl-learn", ciStatus: "failing", ciWorkflowName: "Vercel Deploy", defaultBranch: "main" },
      ],
    };
    const deps = makeDeps({ failingPRs: [], fleetSnapshot: snapshot });
    const result = await reconcileFailingPRs(deps);
    expect(result.mainBranchOpened).toBe(1);
    expect(deps.__created).toHaveLength(1);
    const created = deps.__created[0]!;
    expect(created.githubRepo).toBe("devfellowship/dfl-learn");
    expect(created.githubPrNumber).toBeNull();
    expect(created.originKind).toBe("fleet_watcher");
    expect(created.originId).toBe("devfellowship/dfl-learn#main");
    expect(created.description).toContain("main (default)");

    const calls = (deps.issues.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toMatchObject({
      title: "Fix failing CI: devfellowship/dfl-learn main branch",
      assigneeAgentId: "bb604576-2eb5-4fd3-9088-a48e469e6432",
      priority: "high",
    });
  });

  it("main-branch issue is idempotent (running twice → still 1 issue)", async () => {
    const snapshot: FleetSnapshot = {
      repos: [
        { fullName: "devfellowship/dfl-learn", ciStatus: "failing", ciWorkflowName: "CI" },
      ],
    };
    const deps = makeDeps({ failingPRs: [], fleetSnapshot: snapshot });

    const first = await reconcileFailingPRs(deps);
    expect(first.mainBranchOpened).toBe(1);
    expect(deps.__created).toHaveLength(1);

    const second = await reconcileFailingPRs(deps);
    expect(second.mainBranchOpened).toBe(0);
    expect(second.mainBranchSkipped).toBeGreaterThanOrEqual(1);
    expect(deps.__created).toHaveLength(1);
  });

  it("same repo red on both PR AND main gets 2 separate issues", async () => {
    const snapshot: FleetSnapshot = {
      repos: [
        { fullName: "devfellowship/dfl-learn", ciStatus: "failing", ciWorkflowName: "CI" },
      ],
    };
    const pr: FailingPR = {
      repo: "devfellowship/dfl-learn",
      prNumber: 5,
      failedChecks: [{ name: "build" }],
    };
    const deps = makeDeps({ failingPRs: [pr], fleetSnapshot: snapshot });
    const result = await reconcileFailingPRs(deps);
    expect(result.opened).toBe(1);
    expect(result.mainBranchOpened).toBe(1);
    expect(deps.__created).toHaveLength(2);
    // One PR issue, one main-branch issue
    const prIssue = deps.__created.find((i) => i.githubPrNumber === 5);
    const mainIssue = deps.__created.find((i) => i.githubPrNumber === null);
    expect(prIssue).toBeDefined();
    expect(mainIssue).toBeDefined();
    expect(mainIssue!.originId).toBe("devfellowship/dfl-learn#main");
  });

  it("main branch green after fix → posts 'CI now passing' comment", async () => {
    const existingIssue: FakeIssueRow = {
      id: "issue-main-1",
      companyId: "company-1",
      githubRepo: "devfellowship/dfl-learn",
      githubPrNumber: null,
      status: "todo",
      description: "some description",
      originKind: "fleet_watcher",
      originId: "devfellowship/dfl-learn#main",
    };
    const snapshot: FleetSnapshot = {
      repos: [
        { fullName: "devfellowship/dfl-learn", ciStatus: "passing" },
      ],
    };
    const deps = makeDeps({
      failingPRs: [],
      fleetSnapshot: snapshot,
      existingIssues: [existingIssue],
    });
    const result = await reconcileFailingPRs(deps);
    expect(result.mainBranchResolved).toBe(1);
    expect(deps.__comments).toHaveLength(1);
    expect(deps.__comments[0]!.body).toContain("Main branch CI now passing");
  });

  it("main branch still failing → no comment posted", async () => {
    const existingIssue: FakeIssueRow = {
      id: "issue-main-1",
      companyId: "company-1",
      githubRepo: "devfellowship/dfl-learn",
      githubPrNumber: null,
      status: "todo",
      description: "some description",
      originKind: "fleet_watcher",
      originId: "devfellowship/dfl-learn#main",
    };
    const snapshot: FleetSnapshot = {
      repos: [
        { fullName: "devfellowship/dfl-learn", ciStatus: "failing" },
      ],
    };
    const deps = makeDeps({
      failingPRs: [],
      fleetSnapshot: snapshot,
      existingIssues: [existingIssue],
    });
    const result = await reconcileFailingPRs(deps);
    expect(result.mainBranchResolved).toBe(0);
    expect(deps.__comments).toHaveLength(0);
  });

  it("digest includes main-branch counts", async () => {
    const snapshot: FleetSnapshot = {
      repos: [
        { fullName: "devfellowship/dfl-learn", ciStatus: "failing", ciWorkflowName: "CI" },
        { fullName: "devfellowship/dfl-iam", ciStatus: "failing", ciWorkflowName: "CI" },
      ],
    };
    const deps = makeDeps({ failingPRs: [], fleetSnapshot: snapshot });
    const result = await reconcileFailingPRs(deps);
    expect(result.digest).toContain("2 red main branches");
    expect(result.digest).toContain("2 new tickets");
  });
});

// ---------------------------------------------------------------------------
// resolveAssignee routing
// ---------------------------------------------------------------------------

describe("resolveAssignee", () => {
  it("routes infra repos to dfl-rollout-ops", () => {
    for (const repo of [
      "devfellowship/dfl-ci",
      "devfellowship/dfl-harness",
      "devfellowship/dfl-infra",
      "devfellowship/dfl-fleet-health",
      "devfellowship/dfl-sandbox-manager",
    ]) {
      expect(resolveAssignee(repo)).toBe("52b8e0f6-a267-40ed-9664-d8917f4495b5");
    }
  });

  it("routes app dfl-* repos to dfl-single-repo-impl", () => {
    for (const repo of [
      "devfellowship/dfl-learn",
      "devfellowship/dfl-hq",
      "devfellowship/dfl-mcp-server",
      "devfellowship/dfl-schema",
    ]) {
      expect(resolveAssignee(repo)).toBe("bb604576-2eb5-4fd3-9088-a48e469e6432");
    }
  });

  it("returns undefined for non-dfl repos", () => {
    expect(resolveAssignee("paperclipai/paperclip")).toBeUndefined();
    expect(resolveAssignee("devfellowship/other-tool")).toBeUndefined();
  });
});
