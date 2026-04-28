/**
 * Tests for the multi-gitter adapter service (DEV-165)
 *
 * Strategy: mock the child_process.spawn so tests run without the
 * multi-gitter binary installed.  One pass + one fail example per
 * acceptance criterion (matching DEV-167 test pattern).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal mock of child_process so we control multi-gitter's stdout/stderr
// ---------------------------------------------------------------------------

interface MockProcess {
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
}

let mockStdout = "";
let mockStderr = "";
let mockExitCode: number | null = 0;
let mockSpawnError: Error | null = null;

vi.mock("child_process", () => ({
  spawn: (_cmd: string, _args: string[], _opts: unknown): MockProcess => {
    if (mockSpawnError) {
      // Simulate spawn error — emit "error" event asynchronously
      const proc: MockProcess = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          if (event === "error") {
            setTimeout(() => cb(mockSpawnError!), 0);
          }
        }),
      };
      return proc;
    }

    const proc: MockProcess = {
      stdout: {
        on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
          if (event === "data" && mockStdout) {
            setTimeout(() => cb(Buffer.from(mockStdout)), 0);
          }
        }),
      },
      stderr: {
        on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
          if (event === "data" && mockStderr) {
            setTimeout(() => cb(Buffer.from(mockStderr)), 0);
          }
        }),
      },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "close") {
          setTimeout(() => cb(mockExitCode, null), 10);
        }
      }),
    };
    return proc;
  },
}));

// ---------------------------------------------------------------------------
// Also mock fs.writeFileSync / unlinkSync / mkdtempSync so no disk writes
// ---------------------------------------------------------------------------
vi.mock("fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdtempSync: vi.fn(() => "/tmp/fake-workdir"),
}));
vi.mock("os", () => ({ tmpdir: vi.fn(() => "/tmp") }));
vi.mock("path", async () => {
  const actual = await vi.importActual<typeof import("path")>("path");
  return actual;
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { invokeMultiGitter, type MultiRepoRolloutBody } from "../services/multi-gitter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_BODY: MultiRepoRolloutBody = {
  target_repos: ["devfellowship/dfl-hq", "devfellowship/dfl-learn"],
  change_template: "#!/usr/bin/env bash\necho hello",
  pr_body_template: "## Automated rollout\n\nSee linked issue.",
  success_criteria: "Add AGENTS.md to every dfl-* repo",
};

const BASE_OPTS = {
  githubToken: "ghp_test_token",
};

function makeResult(repo: string, url: string, status: "created" | "error" = "created") {
  return JSON.stringify({ repo, url, status });
}

beforeEach(() => {
  mockStdout = "";
  mockStderr = "";
  mockExitCode = 0;
  mockSpawnError = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("invokeMultiGitter — success cases", () => {
  it("returns a full report when all repos succeed", async () => {
    mockStdout = [
      makeResult("devfellowship/dfl-hq", "https://github.com/devfellowship/dfl-hq/pull/1"),
      makeResult("devfellowship/dfl-learn", "https://github.com/devfellowship/dfl-learn/pull/2"),
    ].join("\n");
    mockExitCode = 0;

    const report = await invokeMultiGitter(BASE_BODY, BASE_OPTS);

    expect(report.repos_targeted).toEqual(BASE_BODY.target_repos);
    expect(report.repos_succeeded).toHaveLength(2);
    expect(report.repos_failed).toHaveLength(0);
    expect(report.pr_urls).toHaveLength(2);
    expect(report.pr_urls[0]).toContain("github.com");
    expect(report.summary).toContain("2/2 repos succeeded");
    expect(report.validation_evidence).toContain("PRs opened");
  });

  it("partial success: one succeeded, one failed", async () => {
    mockStdout = [
      makeResult("devfellowship/dfl-hq", "https://github.com/devfellowship/dfl-hq/pull/1"),
      JSON.stringify({
        repo: "devfellowship/dfl-learn",
        status: "error",
        error: "branch already exists",
      }),
    ].join("\n");
    mockExitCode = 1; // partial failure

    const report = await invokeMultiGitter(BASE_BODY, BASE_OPTS);

    expect(report.repos_succeeded).toEqual(["devfellowship/dfl-hq"]);
    expect(report.repos_failed).toEqual(["devfellowship/dfl-learn"]);
    expect(report.pr_urls).toHaveLength(1);
    expect(report.summary).toContain("1/2 repos succeeded");
    expect(report.summary).toContain("devfellowship/dfl-learn");
  });

  it("already_exists status counts as success", async () => {
    mockStdout = makeResult(
      "devfellowship/dfl-hq",
      "https://github.com/devfellowship/dfl-hq/pull/5",
      // @ts-expect-error — testing with typed const
      "already_exists",
    );
    mockExitCode = 0;

    const report = await invokeMultiGitter(
      { ...BASE_BODY, target_repos: ["devfellowship/dfl-hq"] },
      BASE_OPTS,
    );
    expect(report.repos_succeeded).toEqual(["devfellowship/dfl-hq"]);
    expect(report.repos_failed).toHaveLength(0);
  });

  it("repo missing from output is treated as failed (guard coverage gap)", async () => {
    // Only one repo reported; second is silently missing
    mockStdout = makeResult(
      "devfellowship/dfl-hq",
      "https://github.com/devfellowship/dfl-hq/pull/1",
    );
    mockExitCode = 1;

    const report = await invokeMultiGitter(BASE_BODY, BASE_OPTS);
    // dfl-learn missing from output → failed
    expect(report.repos_failed).toContain("devfellowship/dfl-learn");
  });

  it("ignores non-JSON lines in stdout (progress output)", async () => {
    mockStdout = [
      "Cloning devfellowship/dfl-hq ...",
      makeResult("devfellowship/dfl-hq", "https://github.com/devfellowship/dfl-hq/pull/1"),
      makeResult("devfellowship/dfl-learn", "https://github.com/devfellowship/dfl-learn/pull/2"),
      "Done.",
    ].join("\n");
    mockExitCode = 0;

    const report = await invokeMultiGitter(BASE_BODY, BASE_OPTS);
    expect(report.repos_succeeded).toHaveLength(2);
  });

  it("accepts JSON array output (alternative multi-gitter format)", async () => {
    mockStdout = JSON.stringify([
      { repo: "devfellowship/dfl-hq", url: "https://github.com/devfellowship/dfl-hq/pull/1", status: "created" },
      { repo: "devfellowship/dfl-learn", url: "https://github.com/devfellowship/dfl-learn/pull/2", status: "created" },
    ]);
    mockExitCode = 0;

    const report = await invokeMultiGitter(BASE_BODY, BASE_OPTS);
    expect(report.repos_succeeded).toHaveLength(2);
  });

  it("validation_evidence includes PR URLs", async () => {
    const prUrl = "https://github.com/devfellowship/dfl-hq/pull/99";
    mockStdout = makeResult("devfellowship/dfl-hq", prUrl);
    mockExitCode = 0;

    const report = await invokeMultiGitter(
      { ...BASE_BODY, target_repos: ["devfellowship/dfl-hq"] },
      BASE_OPTS,
    );
    expect(report.validation_evidence).toContain(prUrl);
  });
});

describe("invokeMultiGitter — failure cases", () => {
  it("throws on fatal exit code (>1)", async () => {
    mockStdout = "";
    mockStderr = "authentication failed";
    mockExitCode = 2;

    await expect(invokeMultiGitter(BASE_BODY, BASE_OPTS)).rejects.toThrow(
      /fatal exit 2/,
    );
  });

  it("throws when multi-gitter binary not found (spawn error)", async () => {
    mockSpawnError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

    await expect(invokeMultiGitter(BASE_BODY, BASE_OPTS)).rejects.toThrow(
      /Failed to spawn/,
    );
  });
});
