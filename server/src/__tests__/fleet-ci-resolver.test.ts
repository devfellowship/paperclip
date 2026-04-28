import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearResolverCache,
  RESOLVE_GREEN_STREAK_THRESHOLD,
  resolveCiIssue,
} from "../services/fleet-ci-resolver.js";

const TOKEN = "ghp_test_token";

function makePRResponse(state: string, merged: boolean): Response {
  return new Response(JSON.stringify({ state, merged }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRunsResponse(runs: Array<{ status: string; conclusion: string | null }>): Response {
  return new Response(JSON.stringify({ workflow_runs: runs }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function notFoundResponse(): Response {
  return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
}

function errorResponse(status = 500): Response {
  return new Response("Internal Server Error", { status });
}

beforeEach(() => {
  _clearResolverCache();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// PR issues
// ---------------------------------------------------------------------------

describe("PR issues", () => {
  it("returns resolved=true with reason pr-merged when PR is merged", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makePRResponse("closed", true));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 42 },
      TOKEN,
    );

    expect(result).toEqual({ resolved: true, reason: "pr-merged" });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/devfellowship/dfl-hq/pulls/42",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }) }),
    );
  });

  it("returns resolved=true with reason pr-closed when PR is closed (not merged)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makePRResponse("closed", false));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 7 },
      TOKEN,
    );

    expect(result).toEqual({ resolved: true, reason: "pr-closed" });
  });

  it("returns resolved=false when PR is still open", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makePRResponse("open", false));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 99 },
      TOKEN,
    );

    expect(result).toEqual({ resolved: false });
  });

  it("returns resolved=true with reason pr-not-found on 404", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(notFoundResponse());

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 1 },
      TOKEN,
    );

    expect(result).toEqual({ resolved: true, reason: "pr-not-found" });
  });

  it("returns resolved=false and does NOT cache on GitHub API errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errorResponse());

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 10 },
      TOKEN,
    );

    expect(result).toEqual({ resolved: false });

    // Second call should hit GitHub again (not a cached error)
    vi.mocked(fetch).mockResolvedValueOnce(makePRResponse("closed", true));
    const result2 = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 10 },
      TOKEN,
    );
    expect(result2).toEqual({ resolved: true, reason: "pr-merged" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns resolved=false and does NOT cache on network errors", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network failure"));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 11 },
      TOKEN,
    );

    expect(result).toEqual({ resolved: false });

    // Next call can succeed
    vi.mocked(fetch).mockResolvedValueOnce(makePRResponse("closed", true));
    const result2 = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 11 },
      TOKEN,
    );
    expect(result2).toEqual({ resolved: true, reason: "pr-merged" });
  });
});

// ---------------------------------------------------------------------------
// Main-branch issues (githubPrNumber === null)
// ---------------------------------------------------------------------------

describe("main-branch issues", () => {
  const greenRun = { status: "completed", conclusion: "success" };
  const failedRun = { status: "completed", conclusion: "failure" };
  const inProgressRun = { status: "in_progress", conclusion: null };

  it(`returns resolved=true after exactly ${RESOLVE_GREEN_STREAK_THRESHOLD} consecutive green runs`, async () => {
    const runs = Array.from({ length: RESOLVE_GREEN_STREAK_THRESHOLD }, () => greenRun);
    vi.mocked(fetch).mockResolvedValueOnce(makeRunsResponse(runs));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: null },
      TOKEN,
    );

    expect(result).toEqual({
      resolved: true,
      reason: `main-green-${RESOLVE_GREEN_STREAK_THRESHOLD}-consecutive`,
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://api.github.com/repos/devfellowship/dfl-hq/actions/runs?branch=main&per_page=10`,
      expect.anything(),
    );
  });

  it("returns resolved=true for more than threshold consecutive greens", async () => {
    const runs = Array.from({ length: 7 }, () => greenRun);
    vi.mocked(fetch).mockResolvedValueOnce(makeRunsResponse(runs));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: null },
      TOKEN,
    );

    expect(result).toEqual({ resolved: true, reason: "main-green-7-consecutive" });
  });

  it("returns resolved=false when fewer than threshold consecutive greens", async () => {
    const runs = [greenRun, greenRun, failedRun, greenRun, greenRun];
    vi.mocked(fetch).mockResolvedValueOnce(makeRunsResponse(runs));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: null },
      TOKEN,
    );

    expect(result).toEqual({ resolved: false });
  });

  it("returns resolved=false when most recent run is still in_progress", async () => {
    const runs = [inProgressRun, greenRun, greenRun, greenRun];
    vi.mocked(fetch).mockResolvedValueOnce(makeRunsResponse(runs));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: null },
      TOKEN,
    );

    expect(result).toEqual({ resolved: false });
  });

  it("returns resolved=false for empty runs list", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeRunsResponse([]));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: null },
      TOKEN,
    );

    expect(result).toEqual({ resolved: false });
  });

  it("returns resolved=false and does NOT cache on API error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errorResponse(503));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: null },
      TOKEN,
    );

    expect(result).toEqual({ resolved: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Missing/invalid input
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("returns resolved=false immediately when githubRepo is null", async () => {
    const result = await resolveCiIssue({ githubRepo: null, githubPrNumber: 1 }, TOKEN);
    expect(result).toEqual({ resolved: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats undefined githubPrNumber as a main-branch issue", async () => {
    const runs = Array.from({ length: RESOLVE_GREEN_STREAK_THRESHOLD }, () => ({
      status: "completed",
      conclusion: "success",
    }));
    vi.mocked(fetch).mockResolvedValueOnce(makeRunsResponse(runs));

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq" },
      TOKEN,
    );

    expect(result.resolved).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/actions/runs"),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe("caching", () => {
  it("returns cached result on second call within TTL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makePRResponse("closed", true));

    const r1 = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 5 },
      TOKEN,
    );
    const r2 = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 5 },
      TOKEN,
    );

    expect(r1).toEqual(r2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("separates cache entries by repo + prNumber", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makePRResponse("closed", true))
      .mockResolvedValueOnce(makePRResponse("open", false));

    const r1 = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 1 },
      TOKEN,
    );
    const r2 = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 2 },
      TOKEN,
    );

    expect(r1).toEqual({ resolved: true, reason: "pr-merged" });
    expect(r2).toEqual({ resolved: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("separates cache for PR vs main-branch on same repo", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makePRResponse("open", false))
      .mockResolvedValueOnce(
        makeRunsResponse(
          Array.from({ length: RESOLVE_GREEN_STREAK_THRESHOLD }, () => ({
            status: "completed",
            conclusion: "success",
          })),
        ),
      );

    const prResult = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 1 },
      TOKEN,
    );
    const mainResult = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: null },
      TOKEN,
    );

    expect(prResult.resolved).toBe(false);
    expect(mainResult.resolved).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after cache expiry (via fake timers)", async () => {
    vi.useFakeTimers();

    vi.mocked(fetch)
      .mockResolvedValueOnce(makePRResponse("open", false))
      .mockResolvedValueOnce(makePRResponse("closed", true));

    await resolveCiIssue({ githubRepo: "devfellowship/dfl-hq", githubPrNumber: 9 }, TOKEN);

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const result = await resolveCiIssue(
      { githubRepo: "devfellowship/dfl-hq", githubPrNumber: 9 },
      TOKEN,
    );

    expect(result).toEqual({ resolved: true, reason: "pr-merged" });
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
