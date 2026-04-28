/**
 * Harness v2 — Task Type Taxonomy + Output Schemas (Fase 1.1 + 1.2)
 *
 * Defines the 4 task types, their creation bodies, completion reports,
 * and the validateCompletionReport function that DEV-164 guards will call.
 *
 * Spec: https://plans.tainanfidelis.com/20260411-harness-v2-task-type-taxonomy
 * Implementation issue: DEV-167
 *
 * DEV-251: required_credentials per task type + checkRequiredCredentials()
 */

// ---------------------------------------------------------------------------
// Task type enum
// ---------------------------------------------------------------------------

export const TASK_TYPES = [
  "single-repo-implementation",
  "single-repo-spec",
  "single-repo-verification",
  "multi-repo-rollout",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && TASK_TYPES.includes(value as TaskType);
}

// ---------------------------------------------------------------------------
// Credential capabilities (DEV-251)
//
// Canonical capability names map to regex patterns that match known env var
// keys in the agent's adapterConfig.env.  A task type that requires a
// capability passes the check if the agent has at least one env key matching
// any of the capability's patterns.
// ---------------------------------------------------------------------------

export interface CredentialCapability {
  /** Human-readable description shown in blocked-issue comments. */
  description: string;
  /**
   * One or more regex patterns to test against the agent's adapterConfig.env
   * keys.  At least one key must match for the credential to be considered
   * present.
   */
  envPatterns: RegExp[];
}

export const CREDENTIAL_CAPABILITIES: Record<string, CredentialCapability> = {
  GITHUB_PAT_WITH_CONTENTS_WRITE: {
    description: "GitHub Personal Access Token with contents:write scope",
    envPatterns: [/^GITHUB_PAT/i, /^GH_PAT/i, /^GH_TOKEN$/i],
  },
  SUPABASE_SERVICE_ROLE: {
    description: "Supabase service-role key",
    envPatterns: [/^SUPABASE_SERVICE_ROLE/i, /^SUPABASE_KEY/i],
  },
  INFISICAL_MACHINE_IDENTITY: {
    description: "Infisical machine identity (INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET)",
    envPatterns: [/^INFISICAL_CLIENT_ID$/i],
  },
  NPM_TOKEN: {
    description: "npm publish token",
    envPatterns: [/^NPM_TOKEN/i],
  },
};

/**
 * Required credential capabilities per task type.
 *
 * Per-task overrides can be provided in task_body.required_credentials (an
 * array of capability names). When present, the per-task list is used instead
 * of (not in addition to) the type-level defaults.
 */
export const TASK_TYPE_REQUIRED_CREDENTIALS: Record<TaskType, string[]> = {
  "single-repo-implementation": ["GITHUB_PAT_WITH_CONTENTS_WRITE"],
  "single-repo-spec": [],
  "single-repo-verification": [],
  "multi-repo-rollout": ["GITHUB_PAT_WITH_CONTENTS_WRITE"],
};

export interface CredentialCheckResult {
  ok: boolean;
  /** Capability names that are missing from the agent's env config. */
  missing: string[];
}

/**
 * Check whether the agent's declared env keys satisfy all required credentials
 * for the given task type (or per-task override list).
 *
 * @param taskType          The task's task_type value (may be null/undefined for untyped tasks).
 * @param agentEnvKeys      Keys from the assignee agent's adapterConfig.env object.
 * @param requiredOverride  Optional per-task required_credentials override from task_body.
 */
export function checkRequiredCredentials(
  taskType: TaskType | string | null | undefined,
  agentEnvKeys: string[],
  requiredOverride?: string[] | null,
): CredentialCheckResult {
  // No task type → no credential requirements (legacy tasks pass through)
  if (!taskType || !isTaskType(taskType)) {
    return { ok: true, missing: [] };
  }

  const required =
    Array.isArray(requiredOverride) && requiredOverride.length > 0
      ? requiredOverride
      : TASK_TYPE_REQUIRED_CREDENTIALS[taskType];

  if (!required || required.length === 0) {
    return { ok: true, missing: [] };
  }

  const missing: string[] = [];

  for (const capabilityName of required) {
    const capability = CREDENTIAL_CAPABILITIES[capabilityName];
    if (!capability) {
      // Unknown capability name — treat as missing (conservative)
      missing.push(capabilityName);
      continue;
    }
    const found = agentEnvKeys.some((key) =>
      capability.envPatterns.some((pattern) => pattern.test(key)),
    );
    if (!found) {
      missing.push(capabilityName);
    }
  }

  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Shared fragment types
// ---------------------------------------------------------------------------

export type CommandRun = {
  name: string;
  command: string;
  exit_code: number;
  output_tail?: string; // max 2000 chars
};

export type EvidenceEntry = {
  source: string; // "file:src/main.tsx:42" | "curl:https://..." | "log:..." | "sql:..."
  excerpt: string;
};

// ---------------------------------------------------------------------------
// Creation bodies (per task type)
// ---------------------------------------------------------------------------

export type SingleRepoImplementationBody = {
  repo: string;
  scope: string;
  constraints?: string[];
  acceptance_criteria: string;
  related_issues?: string[];
};

export type SingleRepoSpecBody = {
  topic: string;
  context?: string;
  deliverable_path: string;
};

export type SingleRepoVerificationBody = {
  claim: string;
  method_hint?: string;
  depth: "shallow" | "deep";
};

export type MultiRepoRolloutBody = {
  target_repos: string[];
  change_template: string;
  pr_body_template: string;
  success_criteria: string;
};

export type TaskCreationBody =
  | SingleRepoImplementationBody
  | SingleRepoSpecBody
  | SingleRepoVerificationBody
  | MultiRepoRolloutBody;

// ---------------------------------------------------------------------------
// Completion reports (per task type)
// ---------------------------------------------------------------------------

export type SingleRepoImplementationReport = {
  repo: string;
  branch: string;
  pr_url: string;
  summary: string;
  files_changed: number;
  validations_run: CommandRun[];
  validation_evidence: string;
  unresolved?: string[];
};

export type SingleRepoSpecReport = {
  plan_path: string;
  plan_url: string;
  summary: string;
  unresolved_questions?: string[];
};

export type SingleRepoVerificationReport = {
  claim: string;
  result: "confirmed" | "refuted" | "inconclusive";
  evidence: EvidenceEntry[];
  caveats?: string;
};

export type MultiRepoRolloutReport = {
  repos_targeted: string[];
  repos_succeeded: string[];
  repos_failed: string[];
  pr_urls: string[];
  summary: string;
  validation_evidence: string;
};

export type CompletionReport =
  | SingleRepoImplementationReport
  | SingleRepoSpecReport
  | SingleRepoVerificationReport
  | MultiRepoRolloutReport;

// ---------------------------------------------------------------------------
// JSONSchemas (hardcoded per spec — promote to DB table if runtime updates needed)
// ---------------------------------------------------------------------------

type JSONSchema = Record<string, unknown>;

const commandRunSchema: JSONSchema = {
  type: "object",
  required: ["name", "command", "exit_code"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    command: { type: "string", minLength: 1 },
    exit_code: { type: "integer" },
    output_tail: { type: "string", maxLength: 2000 },
  },
};

const evidenceEntrySchema: JSONSchema = {
  type: "object",
  required: ["source", "excerpt"],
  additionalProperties: false,
  properties: {
    source: {
      type: "string",
      minLength: 1,
      description: "Must start with file:, curl:, log:, or sql:",
    },
    excerpt: { type: "string", minLength: 1 },
  },
};

const COMPLETION_REPORT_SCHEMAS: Record<TaskType, JSONSchema> = {
  "single-repo-implementation": {
    type: "object",
    required: [
      "repo",
      "branch",
      "pr_url",
      "summary",
      "files_changed",
      "validations_run",
      "validation_evidence",
    ],
    additionalProperties: false,
    properties: {
      repo: { type: "string", minLength: 1 },
      branch: { type: "string", minLength: 1 },
      pr_url: {
        type: "string",
        pattern: "^https?://[^\\s]+$",
        description: "Must be a valid HTTPS GitHub PR URL",
      },
      summary: { type: "string", minLength: 10 },
      files_changed: { type: "integer", minimum: 0 },
      validations_run: {
        type: "array",
        items: commandRunSchema,
      },
      validation_evidence: {
        type: "string",
        minLength: 1,
        description: "Non-empty logs or reference to CI",
      },
      unresolved: {
        type: "array",
        items: { type: "string" },
      },
    },
  },

  "single-repo-spec": {
    type: "object",
    required: ["plan_path", "plan_url", "summary"],
    additionalProperties: false,
    properties: {
      plan_path: { type: "string", minLength: 1 },
      plan_url: {
        type: "string",
        pattern: "^https://[^\\s]+$",
        description: "Must be a public HTTPS URL on plans.tainanfidelis.com",
      },
      summary: { type: "string", minLength: 10 },
      unresolved_questions: {
        type: "array",
        items: { type: "string" },
      },
    },
  },

  "single-repo-verification": {
    type: "object",
    required: ["claim", "result", "evidence"],
    additionalProperties: false,
    properties: {
      claim: { type: "string", minLength: 1 },
      result: {
        type: "string",
        enum: ["confirmed", "refuted", "inconclusive"],
      },
      evidence: {
        type: "array",
        items: evidenceEntrySchema,
        minItems: 1,
      },
      caveats: { type: "string" },
    },
  },

  "multi-repo-rollout": {
    type: "object",
    required: [
      "repos_targeted",
      "repos_succeeded",
      "repos_failed",
      "pr_urls",
      "summary",
      "validation_evidence",
    ],
    additionalProperties: false,
    properties: {
      repos_targeted: { type: "array", items: { type: "string" }, minItems: 1 },
      repos_succeeded: { type: "array", items: { type: "string" } },
      repos_failed: { type: "array", items: { type: "string" } },
      pr_urls: {
        type: "array",
        items: { type: "string", pattern: "^https?://[^\\s]+$" },
      },
      summary: { type: "string", minLength: 10 },
      validation_evidence: { type: "string", minLength: 1 },
    },
  },
};

export function getCompletionReportSchema(taskType: TaskType): JSONSchema {
  return COMPLETION_REPORT_SCHEMAS[taskType];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationError = {
  field: string;
  message: string;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

/**
 * Validates a completion report against the JSONSchema for the given task type.
 *
 * This is a bespoke validator — no external library dependency — to keep the
 * server bundle lean. It covers the shapes defined in the schemas above.
 * DEV-164 guards call this function; they add their own higher-level checks
 * (URL reachability, PR existence, etc.) on top.
 */
export function validateCompletionReport(
  taskType: TaskType,
  report: unknown,
): ValidationResult {
  const errors: ValidationError[] = [];

  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, errors: [{ field: ".", message: "Report must be an object" }] };
  }

  const r = report as Record<string, unknown>;

  switch (taskType) {
    case "single-repo-implementation":
      validateSingleRepoImpl(r, errors);
      break;
    case "single-repo-spec":
      validateSingleRepoSpec(r, errors);
      break;
    case "single-repo-verification":
      validateSingleRepoVerification(r, errors);
      break;
    case "multi-repo-rollout":
      validateMultiRepoRollout(r, errors);
      break;
    default: {
      const _exhaustive: never = taskType;
      errors.push({ field: "task_type", message: `Unknown task type: ${_exhaustive}` });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Per-type validators
// ---------------------------------------------------------------------------

function requireString(
  obj: Record<string, unknown>,
  field: string,
  minLen: number,
  errors: ValidationError[],
): void {
  const val = obj[field];
  if (typeof val !== "string" || val.length < minLen) {
    errors.push({
      field,
      message:
        minLen > 1
          ? `Must be a non-empty string with at least ${minLen} characters`
          : "Must be a non-empty string",
    });
  }
}

function requireStringArray(
  obj: Record<string, unknown>,
  field: string,
  errors: ValidationError[],
  minItems = 0,
): void {
  const val = obj[field];
  if (!Array.isArray(val)) {
    errors.push({ field, message: "Must be an array" });
    return;
  }
  if (val.length < minItems) {
    errors.push({ field, message: `Must contain at least ${minItems} item(s)` });
    return;
  }
  for (let i = 0; i < val.length; i++) {
    if (typeof val[i] !== "string") {
      errors.push({ field: `${field}[${i}]`, message: "Must be a string" });
    }
  }
}

function requireUrl(
  obj: Record<string, unknown>,
  field: string,
  errors: ValidationError[],
  requireHttps = false,
): void {
  const val = obj[field];
  if (typeof val !== "string") {
    errors.push({ field, message: "Must be a URL string" });
    return;
  }
  const pattern = requireHttps ? /^https:\/\/[^\s]+$/ : /^https?:\/\/[^\s]+$/;
  if (!pattern.test(val)) {
    errors.push({
      field,
      message: requireHttps
        ? "Must be a valid HTTPS URL"
        : "Must be a valid HTTP/HTTPS URL",
    });
  }
}

function requireInteger(
  obj: Record<string, unknown>,
  field: string,
  errors: ValidationError[],
  minimum = 0,
): void {
  const val = obj[field];
  if (typeof val !== "number" || !Number.isInteger(val) || val < minimum) {
    errors.push({
      field,
      message: `Must be an integer >= ${minimum}`,
    });
  }
}

function validateCommandRun(
  val: unknown,
  prefix: string,
  errors: ValidationError[],
): void {
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    errors.push({ field: prefix, message: "Must be an object" });
    return;
  }
  const r = val as Record<string, unknown>;
  requireString(r, "name", 1, errors);
  requireString(r, "command", 1, errors);
  if (typeof r["exit_code"] !== "number" || !Number.isInteger(r["exit_code"])) {
    errors.push({ field: `${prefix}.exit_code`, message: "Must be an integer" });
  }
  if (r["output_tail"] !== undefined) {
    if (typeof r["output_tail"] !== "string" || r["output_tail"].length > 2000) {
      errors.push({ field: `${prefix}.output_tail`, message: "Must be a string ≤ 2000 chars" });
    }
  }
}

const EVIDENCE_SOURCE_PATTERN = /^(file:|curl:|log:|sql:)/;

function validateEvidenceEntry(
  val: unknown,
  prefix: string,
  errors: ValidationError[],
): void {
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    errors.push({ field: prefix, message: "Must be an object" });
    return;
  }
  const r = val as Record<string, unknown>;
  if (typeof r["source"] !== "string" || !EVIDENCE_SOURCE_PATTERN.test(r["source"])) {
    errors.push({
      field: `${prefix}.source`,
      message: "Must start with file:, curl:, log:, or sql:",
    });
  }
  if (typeof r["excerpt"] !== "string" || r["excerpt"].length === 0) {
    errors.push({ field: `${prefix}.excerpt`, message: "Must be a non-empty string" });
  }
}

function validateSingleRepoImpl(
  r: Record<string, unknown>,
  errors: ValidationError[],
): void {
  requireString(r, "repo", 1, errors);
  requireString(r, "branch", 1, errors);
  requireUrl(r, "pr_url", errors, false);
  requireString(r, "summary", 10, errors);
  requireInteger(r, "files_changed", errors, 0);

  if (!Array.isArray(r["validations_run"])) {
    errors.push({ field: "validations_run", message: "Must be an array" });
  } else {
    (r["validations_run"] as unknown[]).forEach((item, i) => {
      validateCommandRun(item, `validations_run[${i}]`, errors);
    });
  }

  requireString(r, "validation_evidence", 1, errors);

  if (r["unresolved"] !== undefined) {
    requireStringArray(r, "unresolved", errors);
  }
}

function validateSingleRepoSpec(
  r: Record<string, unknown>,
  errors: ValidationError[],
): void {
  requireString(r, "plan_path", 1, errors);
  requireUrl(r, "plan_url", errors, true);
  requireString(r, "summary", 10, errors);
  if (r["unresolved_questions"] !== undefined) {
    requireStringArray(r, "unresolved_questions", errors);
  }
}

function validateSingleRepoVerification(
  r: Record<string, unknown>,
  errors: ValidationError[],
): void {
  requireString(r, "claim", 1, errors);

  const validResults = ["confirmed", "refuted", "inconclusive"] as const;
  if (!validResults.includes(r["result"] as (typeof validResults)[number])) {
    errors.push({
      field: "result",
      message: `Must be one of: ${validResults.join(", ")}`,
    });
  }

  if (!Array.isArray(r["evidence"]) || r["evidence"].length === 0) {
    errors.push({
      field: "evidence",
      message: "Must be a non-empty array with at least 1 evidence entry",
    });
  } else {
    (r["evidence"] as unknown[]).forEach((item, i) => {
      validateEvidenceEntry(item, `evidence[${i}]`, errors);
    });
  }
}

function validateMultiRepoRollout(
  r: Record<string, unknown>,
  errors: ValidationError[],
): void {
  requireStringArray(r, "repos_targeted", errors, 1);
  requireStringArray(r, "repos_succeeded", errors);
  requireStringArray(r, "repos_failed", errors);

  if (!Array.isArray(r["pr_urls"])) {
    errors.push({ field: "pr_urls", message: "Must be an array" });
  } else {
    (r["pr_urls"] as unknown[]).forEach((item, i) => {
      if (typeof item !== "string" || !/^https?:\/\/[^\s]+$/.test(item)) {
        errors.push({ field: `pr_urls[${i}]`, message: "Must be a valid HTTP/HTTPS URL" });
      }
    });
  }

  requireString(r, "summary", 10, errors);
  requireString(r, "validation_evidence", 1, errors);
}
