// server/src/services/guards.ts
// DEV-164 — Harness v2 Fase 3: Deterministic guards
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
 * Stub — always passes. Will be enhanced when multi-repo task types are defined.
 * Applies to: in_progress → in_review
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function requireRepoCoverage(_comment: string): GuardResult {
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
