/**
 * Contract tests for fleet-health /api/failing-prs response parsing (DEV-402).
 *
 * The fleet-health API changed from returning a bare FailingPR[] to an
 * envelope: { collectedAt, total, prs: FailingPR[] }. fetchFailingPRs must
 * accept both shapes gracefully.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchFailingPRs, type FailingPR } from "../services/fleet-regression-watcher.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PR_FIXTURE: FailingPR = {
  repo: "devfellowship/dfl-hq",
  prNumber: 42,
  title: "Add caching",
  branch: "feat/caching",
  author: "@tainan",
  failedChecks: [{ name: "ci-build", htmlUrl: "https://gh/run" }],
};

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fleet-health /api/failing-prs contract", () => {
  it("parses a bare array response (legacy shape)", async () => {
    mockFetchResponse([PR_FIXTURE]);
    const result = await fetchFailingPRs();
    expect(result).toHaveLength(1);
    expect(result[0]!.repo).toBe("devfellowship/dfl-hq");
    expect(result[0]!.prNumber).toBe(42);
  });

  it("parses an envelope { prs: [...] } response (current shape)", async () => {
    mockFetchResponse({
      collectedAt: "2026-04-20T15:07:45.855Z",
      total: 1,
      prs: [PR_FIXTURE],
    });
    const result = await fetchFailingPRs();
    expect(result).toHaveLength(1);
    expect(result[0]!.repo).toBe("devfellowship/dfl-hq");
    expect(result[0]!.prNumber).toBe(42);
  });

  it("returns empty array for envelope with total=0 and empty prs", async () => {
    mockFetchResponse({
      collectedAt: "2026-04-20T15:07:45.855Z",
      total: 0,
      prs: [],
    });
    const result = await fetchFailingPRs();
    expect(result).toHaveLength(0);
  });

  it("returns empty array for null/non-OK responses", async () => {
    mockFetchResponse(null, false, 500);
    const result = await fetchFailingPRs();
    expect(result).toHaveLength(0);
  });

  it("filters out malformed entries from either shape", async () => {
    mockFetchResponse({
      total: 3,
      prs: [
        PR_FIXTURE,
        { repo: "missing-pr-number" }, // invalid
        { prNumber: 99 }, // invalid — no repo
      ],
    });
    const result = await fetchFailingPRs();
    expect(result).toHaveLength(1);
    expect(result[0]!.repo).toBe("devfellowship/dfl-hq");
  });

  it("handles envelope with missing prs key gracefully", async () => {
    mockFetchResponse({ collectedAt: "2026-04-20T15:07:45.855Z", total: 5 });
    const result = await fetchFailingPRs();
    expect(result).toHaveLength(0);
  });
});
