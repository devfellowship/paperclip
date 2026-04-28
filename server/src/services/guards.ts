// server/src/services/guards.ts
// DEV-164 — Harness v2 Fase 3: Deterministic guards
// DEV-165 — requireRepoCoverage implemented (multi-repo rollout support)
// Injected via paperclip:custom Dockerfile PATCH 5.1
// Called from routes/issues.ts PATCH /issues/:id before svc.update()
//
// Guards intercept agent status transitions:
//   in_progress → in_review : requireValidationEvidence, requireOutputSchema, requirePRUrl, requireRepoCoverage
//   in_review   → done      : requireValidationEvidence, requireOutputSchema

export interface GuardResult {
  ok: boolean;
  reason?: string;
  escalate?: "block" | "reopen";
}

/** Transitions that require guard checks */
const GUARDED_TRANSITIONS: Array<[string, string]> = [
  ["in_progress", "in_review"],
  ["in_review", "done"],
];

function isGuardedTransition(from: string, to: string): boolean {
  return GUARDED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

// ──────────────────────────────────────────────
// Guard implementations
// ──────────────────────────────────────────────

/**
 * requireValidationEvidence
 * Rejects if the transition comment is empty or a known placeholder.
 * Applies to: in_progress → in_review, in_review → done
 */
function requireValidationEvidence(comment: string): GuardResult {
  const trimmed = comment.trim();
  if (!trimmed || /^\(none\)$/i.test(trimmed)) {
    return {
      ok: false,
      reason: "Validation evidence missing: comment is empty or placeholder '(none)'",
      escalate: "block",
    };
  }
  return { ok: true };
}

/**
 * requireOutputSchema
 * Rejects if the transition report is too short to be meaningful.
 * A proper report has ≥50 chars and ≥2 non-empty lines.
 * Applies to: in_progress → in_review, in_review → done
 */
function requireOutputSchema(comment: string): GuardResult {
  const trimmed = comment.trim();
  const nonEmptyLines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (trimmed.length < 50 || nonEmptyLines.length < 2) {
    return {
      ok: false,
      reason: "Output schema invalid: transition report too short (need ≥50 chars and ≥2 non-empty lines)",
      escalate: "block",
    };
  }
  return { ok: true };
}

/**
 * requirePRUrl
 * Rejects if no GitHub pull-request URL is found in the comment.
 * Applies to: in_progress → in_review only
 */
const PR_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i;
function requirePRUrl(comment: string): GuardResult {
  if (!PR_URL_RE.test(comment)) {
    return {
      ok: false,
      reason:
        "PR URL missing: comment must include a valid GitHub pull request URL " +
        "(e.g. https://github.com/org/repo/pull/123)",
      escalate: "block",
    };
  }
  return { ok: true };
}

/**
 * requireRepoCoverage
 * For multi-repo-rollout tasks: validates that the completion report's
 * coverage is complete — i.e. no repo silently dropped.
 *
 * Rule (DEV-165):
 *   len(repos_succeeded) + len(repos_failed) == len(repos_targeted)
 *
 * The guard looks for a JSON block tagged with "multi-repo-report:" in the
 * transition comment.  If no such block is present (non-rollout task types),
 * the guard passes without action.
 *
 * Applies to: in_progress → in_review
 */
function requireRepoCoverage(comment: string): GuardResult {
  // Extract JSON report from comment — agents embed it as:
  //   multi-repo-report: { "repos_targeted": [...], "repos_succeeded": [...], "repos_failed": [...], ... }
  const match = comment.match(/multi-repo-report:\s*(\{[\s\S]*?\}(?=\s*\n|$))/m);
  if (!match) {
    // No embedded report — this is not a multi-repo-rollout task; pass.
    return { ok: true };
  }

  let report: Record<string, unknown>;
  try {
    report = JSON.parse(match[1]);
  } catch {
    return {
      ok: false,
      reason:
        "requireRepoCoverage: multi-repo-report block found but JSON is invalid. " +
        "Ensure the report is a valid JSON object.",
      escalate: "block",
    };
  }

  const targeted = Array.isArray(report["repos_targeted"]) ? report["repos_targeted"] as unknown[] : null;
  const succeeded = Array.isArray(report["repos_succeeded"]) ? report["repos_succeeded"] as unknown[] : null;
  const failed = Array.isArray(report["repos_failed"]) ? report["repos_failed"] as unknown[] : null;

  if (!targeted || !succeeded || !failed) {
    return {
      ok: false,
      reason:
        "requireRepoCoverage: multi-repo-report must include repos_targeted, repos_succeeded, and repos_failed arrays.",
      escalate: "block",
    };
  }

  const accountedFor = succeeded.length + failed.length;
  if (accountedFor !== targeted.length) {
    return {
      ok: false,
      reason:
        `requireRepoCoverage: coverage gap detected. ` +
        `targeted=${targeted.length}, succeeded=${succeeded.length}, failed=${failed.length} ` +
        `(succeeded + failed must equal targeted — no silent drops allowed).`,
      escalate: "block",
    };
  }

  return { ok: true };
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

export interface RunGuardsInput {
  issue: {
    id: string;
    status: string;
    identifier?: string | null;
    title?: string | null;
  };
  requestedStatus: string;
  comment: string;
  /** actorType from getActorInfo() — guards only fire for "agent" actors */
  actorType: string;
}

/**
 * Run all guards that apply to the given status transition.
 *
 * Returns a (possibly empty) array of GuardResult values.
 * The first failing result should be used for escalation decisions.
 */
export function runGuards(input: RunGuardsInput): GuardResult[] {
  const { issue, requestedStatus, comment, actorType } = input;

  // Guards only fire for agent-triggered transitions
  if (actorType !== "agent") return [];

  // Guards only fire for transitions we care about
  if (!isGuardedTransition(issue.status, requestedStatus)) return [];

  const isInProgressToReview =
    issue.status === "in_progress" && requestedStatus === "in_review";

  const results: GuardResult[] = [];

  // Both guarded transitions: evidence + schema
  results.push(requireValidationEvidence(comment));
  results.push(requireOutputSchema(comment));

  // in_progress → in_review only: PR URL + repo coverage
  if (isInProgressToReview) {
    results.push(requirePRUrl(comment));
    results.push(requireRepoCoverage(comment));
  }

  return results;
}
