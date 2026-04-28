import { describe, expect, it } from "vitest";
import {
  validateCompletionReport,
  isTaskType,
  getCompletionReportSchema,
  type TaskType,
} from "../services/task-types.ts";

// ---------------------------------------------------------------------------
// isTaskType
// ---------------------------------------------------------------------------

describe("isTaskType", () => {
  it("accepts all known task types", () => {
    expect(isTaskType("single-repo-implementation")).toBe(true);
    expect(isTaskType("single-repo-spec")).toBe(true);
    expect(isTaskType("single-repo-verification")).toBe(true);
    expect(isTaskType("multi-repo-rollout")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isTaskType("internal-meta")).toBe(false);
    expect(isTaskType("")).toBe(false);
    expect(isTaskType(null)).toBe(false);
    expect(isTaskType(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCompletionReportSchema
// ---------------------------------------------------------------------------

describe("getCompletionReportSchema", () => {
  it("returns a schema for each task type", () => {
    const types: TaskType[] = [
      "single-repo-implementation",
      "single-repo-spec",
      "single-repo-verification",
      "multi-repo-rollout",
    ];
    for (const t of types) {
      const schema = getCompletionReportSchema(t);
      expect(schema).toBeDefined();
      expect(schema.type).toBe("object");
      expect(Array.isArray((schema as any).required)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// single-repo-implementation
// ---------------------------------------------------------------------------

describe("validateCompletionReport / single-repo-implementation", () => {
  const VALID = {
    repo: "devfellowship/dfl-payments",
    branch: "feat/dev-158-otel-instrumentation",
    pr_url: "https://github.com/devfellowship/dfl-payments/pull/42",
    summary: "Added OTEL instrumentation to the payments service with Langfuse exporter.",
    files_changed: 7,
    validations_run: [
      {
        name: "npm run build",
        command: "npm run build",
        exit_code: 0,
      },
      {
        name: "npm test",
        command: "npm test",
        exit_code: 0,
        output_tail: "All tests passed",
      },
    ],
    validation_evidence: "CI passed — see PR #42 checks",
  };

  it("passes a valid report", () => {
    expect(validateCompletionReport("single-repo-implementation", VALID)).toEqual({ ok: true });
  });

  it("passes with optional unresolved field", () => {
    const report = { ...VALID, unresolved: ["Could not enable E2E tracing in staging"] };
    expect(validateCompletionReport("single-repo-implementation", report)).toEqual({ ok: true });
  });

  it("fails when pr_url is missing", () => {
    const { pr_url: _, ...rest } = VALID;
    const result = validateCompletionReport("single-repo-implementation", rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === "pr_url")).toBe(true);
  });

  it("fails when pr_url is not a URL", () => {
    const report = { ...VALID, pr_url: "not-a-url" };
    const result = validateCompletionReport("single-repo-implementation", report);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === "pr_url")).toBe(true);
  });

  it("fails when validation_evidence is empty", () => {
    const report = { ...VALID, validation_evidence: "" };
    const result = validateCompletionReport("single-repo-implementation", report);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "validation_evidence")).toBe(true);
    }
  });

  it("fails when summary is too short", () => {
    const report = { ...VALID, summary: "Short" };
    const result = validateCompletionReport("single-repo-implementation", report);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === "summary")).toBe(true);
  });

  it("fails when files_changed is negative", () => {
    const report = { ...VALID, files_changed: -1 };
    const result = validateCompletionReport("single-repo-implementation", report);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === "files_changed")).toBe(true);
  });

  it("fails when validations_run item has invalid exit_code", () => {
    const report = {
      ...VALID,
      validations_run: [{ name: "build", command: "npm run build", exit_code: "zero" }],
    };
    const result = validateCompletionReport("single-repo-implementation", report);
    expect(result.ok).toBe(false);
  });

  it("fails when report is not an object", () => {
    const result = validateCompletionReport("single-repo-implementation", "not an object");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// single-repo-spec
// ---------------------------------------------------------------------------

describe("validateCompletionReport / single-repo-spec", () => {
  const VALID = {
    plan_path: "plans/20260412-dfl-payments-invoice-export.md",
    plan_url: "https://plans.tainanfidelis.com/20260412-dfl-payments-invoice-export",
    summary: "Spec covers all invoice export formats plus async job queue design.",
  };

  it("passes a valid report", () => {
    expect(validateCompletionReport("single-repo-spec", VALID)).toEqual({ ok: true });
  });

  it("passes with optional unresolved_questions", () => {
    const report = { ...VALID, unresolved_questions: ["Should we support XLSX?"] };
    expect(validateCompletionReport("single-repo-spec", report)).toEqual({ ok: true });
  });

  it("fails when plan_url is HTTP not HTTPS", () => {
    const report = { ...VALID, plan_url: "http://plans.tainanfidelis.com/plan" };
    const result = validateCompletionReport("single-repo-spec", report);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === "plan_url")).toBe(true);
  });

  it("fails when plan_path is missing", () => {
    const { plan_path: _, ...rest } = VALID;
    const result = validateCompletionReport("single-repo-spec", rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.field === "plan_path")).toBe(true);
  });

  it("fails when summary is too short", () => {
    const report = { ...VALID, summary: "Brief" };
    const result = validateCompletionReport("single-repo-spec", report);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// single-repo-verification
// ---------------------------------------------------------------------------

describe("validateCompletionReport / single-repo-verification", () => {
  const VALID = {
    claim: "dfl-payments has Sentry error boundary in production",
    result: "confirmed" as const,
    evidence: [
      {
        source: "file:src/main.tsx:42",
        excerpt: "import * as Sentry from '@sentry/react'",
      },
      {
        source: "curl:https://dfl-payments.devfellowship.com/health",
        excerpt: "HTTP 200 — sentry: true",
      },
    ],
  };

  it("passes a valid report", () => {
    expect(validateCompletionReport("single-repo-verification", VALID)).toEqual({ ok: true });
  });

  it("passes all three result values", () => {
    for (const result of ["confirmed", "refuted", "inconclusive"] as const) {
      expect(
        validateCompletionReport("single-repo-verification", { ...VALID, result }),
      ).toEqual({ ok: true });
    }
  });

  it("fails when result is an invalid enum value", () => {
    const report = { ...VALID, result: "unknown" };
    const res = validateCompletionReport("single-repo-verification", report);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.field === "result")).toBe(true);
  });

  it("fails when evidence is empty array", () => {
    const report = { ...VALID, evidence: [] };
    const res = validateCompletionReport("single-repo-verification", report);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.field === "evidence")).toBe(true);
  });

  it("fails when evidence entry source has bad prefix", () => {
    const report = {
      ...VALID,
      evidence: [{ source: "github:devfellowship/dfl-payments", excerpt: "some text" }],
    };
    const res = validateCompletionReport("single-repo-verification", report);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.field === "evidence[0].source")).toBe(true);
    }
  });

  it("fails when claim is missing", () => {
    const { claim: _, ...rest } = VALID;
    const res = validateCompletionReport("single-repo-verification", rest);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// multi-repo-rollout
// ---------------------------------------------------------------------------

describe("validateCompletionReport / multi-repo-rollout", () => {
  const VALID = {
    repos_targeted: ["devfellowship/dfl-payments", "devfellowship/dfl-learn"],
    repos_succeeded: ["devfellowship/dfl-payments", "devfellowship/dfl-learn"],
    repos_failed: [],
    pr_urls: [
      "https://github.com/devfellowship/dfl-payments/pull/10",
      "https://github.com/devfellowship/dfl-learn/pull/5",
    ],
    summary: "Applied OTEL instrumentation template to 2 repos, all CIs green.",
    validation_evidence: "Both PRs show green CI checks.",
  };

  it("passes a valid report", () => {
    expect(validateCompletionReport("multi-repo-rollout", VALID)).toEqual({ ok: true });
  });

  it("passes with some repos_failed", () => {
    const report = {
      ...VALID,
      repos_targeted: ["devfellowship/dfl-payments", "devfellowship/dfl-iam"],
      repos_succeeded: ["devfellowship/dfl-payments"],
      repos_failed: ["devfellowship/dfl-iam"],
      pr_urls: ["https://github.com/devfellowship/dfl-payments/pull/10"],
    };
    expect(validateCompletionReport("multi-repo-rollout", report)).toEqual({ ok: true });
  });

  it("fails when repos_targeted is empty", () => {
    const report = { ...VALID, repos_targeted: [] };
    const res = validateCompletionReport("multi-repo-rollout", report);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.field === "repos_targeted")).toBe(true);
  });

  it("fails when pr_urls contains an invalid URL", () => {
    const report = { ...VALID, pr_urls: ["not-a-url"] };
    const res = validateCompletionReport("multi-repo-rollout", report);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.field === "pr_urls[0]")).toBe(true);
  });

  it("fails when validation_evidence is empty", () => {
    const report = { ...VALID, validation_evidence: "" };
    const res = validateCompletionReport("multi-repo-rollout", report);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkRequiredCredentials (DEV-251)
// ---------------------------------------------------------------------------

import {
  checkRequiredCredentials,
  TASK_TYPE_REQUIRED_CREDENTIALS,
} from "../services/task-types.ts";

describe("checkRequiredCredentials", () => {
  it("passes when agent has GITHUB_PAT env key for single-repo-implementation", () => {
    const result = checkRequiredCredentials(
      "single-repo-implementation",
      ["GITHUB_PAT_BRO", "INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET"],
    );
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("fails when agent has no GitHub PAT for single-repo-implementation", () => {
    const result = checkRequiredCredentials(
      "single-repo-implementation",
      ["INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "NPM_TOKEN"],
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("GITHUB_PAT_WITH_CONTENTS_WRITE");
  });

  it("passes for single-repo-spec with empty env (no credentials required)", () => {
    const result = checkRequiredCredentials("single-repo-spec", []);
    expect(result.ok).toBe(true);
  });

  it("passes for single-repo-verification with empty env (no credentials required)", () => {
    const result = checkRequiredCredentials("single-repo-verification", []);
    expect(result.ok).toBe(true);
  });

  it("fails for multi-repo-rollout without GitHub PAT", () => {
    const result = checkRequiredCredentials("multi-repo-rollout", ["SUPABASE_SERVICE_ROLE_KEY"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("GITHUB_PAT_WITH_CONTENTS_WRITE");
  });

  it("passes for multi-repo-rollout with GH_TOKEN", () => {
    const result = checkRequiredCredentials("multi-repo-rollout", ["GH_TOKEN"]);
    expect(result.ok).toBe(true);
  });

  it("passes for unknown task type (legacy tasks bypass)", () => {
    const result = checkRequiredCredentials("legacy-unknown-type", ["some-key"]);
    expect(result.ok).toBe(true);
  });

  it("passes for null task type (untyped task)", () => {
    const result = checkRequiredCredentials(null, []);
    expect(result.ok).toBe(true);
  });

  it("uses per-task override when provided", () => {
    // Override to require SUPABASE_SERVICE_ROLE for an otherwise low-req type
    const result = checkRequiredCredentials(
      "single-repo-spec",
      ["INFISICAL_CLIENT_ID"],
      ["SUPABASE_SERVICE_ROLE"],
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("SUPABASE_SERVICE_ROLE");
  });

  it("per-task override with empty array falls back to type defaults", () => {
    // Empty override should not override — falls back to type defaults
    const result = checkRequiredCredentials(
      "single-repo-implementation",
      ["INFISICAL_CLIENT_ID"],
      [],
    );
    // Empty array = no override, type defaults apply
    expect(result.ok).toBe(false);
  });

  it("GH_PAT prefix matches GITHUB_PAT_WITH_CONTENTS_WRITE capability", () => {
    const result = checkRequiredCredentials(
      "single-repo-implementation",
      ["GH_PAT_DEV"],
    );
    expect(result.ok).toBe(true);
  });
});
