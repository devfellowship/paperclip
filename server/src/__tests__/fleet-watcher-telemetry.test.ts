import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/api", () => {
  const addFn = vi.fn();
  return {
    metrics: {
      getMeter: () => ({
        createCounter: () => ({ add: addFn }),
      }),
    },
    __mockCounterAdd: addFn,
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { recordAutoClose } from "../services/fleet-watcher-telemetry.js";
import { logger } from "../middleware/logger.js";

const otelApi = await import("@opentelemetry/api");
const counterAdd = (otelApi as any).__mockCounterAdd as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordAutoClose", () => {
  it("increments the OTel counter with the reason attribute", () => {
    recordAutoClose({
      issueId: "abc-123",
      githubRepo: "devfellowship/dfl-hq",
      githubPrNumber: 42,
      reason: "pr-absent",
      evidence: "PR #42 absent from snapshot",
    });

    expect(counterAdd).toHaveBeenCalledWith(1, { reason: "pr-absent" });
  });

  it("emits a structured audit log with all fields", () => {
    recordAutoClose({
      issueId: "def-456",
      githubRepo: "devfellowship/dfl-ci",
      githubPrNumber: null,
      reason: "main-green-streak",
      evidence: "Main branch green for 4 consecutive observations",
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "fleet_watcher.auto_closed",
        issueId: "def-456",
        githubRepo: "devfellowship/dfl-ci",
        githubPrNumber: null,
        reason: "main-green-streak",
        evidence: "Main branch green for 4 consecutive observations",
      }),
      "fleet-watcher: issue auto-closed",
    );
  });

  it("handles PR auto-close with correct reason", () => {
    recordAutoClose({
      issueId: "ghi-789",
      githubRepo: "devfellowship/dfl-mcp-server",
      githubPrNumber: 10,
      reason: "pr-absent",
      evidence: "PR #10 absent from openPRBranches in fleet snapshot",
    });

    expect(counterAdd).toHaveBeenCalledWith(1, { reason: "pr-absent" });
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
