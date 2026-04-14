/**
 * multi-gitter adapter service
 * Harness v2 Fase 4 — Multi-repo rollout task type (DEV-165)
 *
 * Wraps the multi-gitter CLI to execute fleet-wide PRs from a structured
 * MultiRepoRolloutBody and return a standardized MultiRepoRolloutReport.
 *
 * multi-gitter docs: https://github.com/lindell/multi-gitter
 * Task type spec:    https://plans.tainanfidelis.com/20260411-harness-v2-task-type-taxonomy
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types (mirrors task-types.ts; keep in sync manually or import when merged)
// ---------------------------------------------------------------------------

export interface MultiRepoRolloutBody {
  /** GitHub org/repo slugs to target (e.g. ["devfellowship/dfl-hq"]) */
  target_repos: string[];
  /** Shell script that receives the repo at CWD and applies the change */
  change_template: string;
  /** Markdown body to use for every opened PR */
  pr_body_template: string;
  /** Human-readable success criterion logged in the completion report */
  success_criteria: string;
}

export interface MultiRepoRolloutReport {
  repos_targeted: string[];
  repos_succeeded: string[];
  repos_failed: string[];
  /** One GitHub PR URL per succeeded repo */
  pr_urls: string[];
  summary: string;
  validation_evidence: string;
}

// ---------------------------------------------------------------------------
// Internal multi-gitter output types
// ---------------------------------------------------------------------------

interface MultiGitterPRResult {
  /** Full GitHub PR URL */
  url?: string;
  /** Repo slug: org/repo */
  repo?: string;
  status?: "created" | "already_exists" | "error";
  error?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface MultiGitterOptions {
  /** GitHub token used for authentication */
  githubToken: string;
  /** Branch name for the PRs (default: "agent-rollout/<timestamp>") */
  branch?: string;
  /** PR title (default: derived from success_criteria) */
  prTitle?: string;
  /** commit message (default: "chore: automated rollout") */
  commitMessage?: string;
  /** Abort after this many consecutive failures (default: 5) */
  maxErrorCount?: number;
  /** Working dir for temporary scripts (default: os.tmpdir()) */
  workDir?: string;
}

/**
 * Execute a multi-repo rollout via multi-gitter.
 *
 * The change_template must be a valid shell script. It is written to a
 * temporary file and passed to `multi-gitter run`. multi-gitter clones
 * each repo, runs the script at the repo root, and opens a PR if anything
 * changed.
 *
 * @throws if multi-gitter exits with a non-zero code that is not a
 *         partial-failure (partial failures are captured per-repo).
 */
export async function invokeMultiGitter(
  body: MultiRepoRolloutBody,
  opts: MultiGitterOptions,
): Promise<MultiRepoRolloutReport> {
  const branch =
    opts.branch ?? `agent-rollout/${Date.now()}`;
  const prTitle =
    opts.prTitle ?? deriveTitle(body.success_criteria);
  const commitMessage =
    opts.commitMessage ?? "chore: automated rollout";
  const maxErrorCount = opts.maxErrorCount ?? 5;

  // Write the change template to a temp script
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), "multi-gitter-"));
  const scriptPath = join(workDir, "change.sh");
  writeFileSync(scriptPath, body.change_template, { mode: 0o755 });

  // Build repo list args: multi-gitter accepts --repo org/repo…
  const repoArgs = body.target_repos.flatMap((r) => ["--repo", r]);

  const args = [
    "run",
    scriptPath,
    "--branch", branch,
    "--pr-title", prTitle,
    "--commit-message", commitMessage,
    "--max-repo-count", String(body.target_repos.length),
    "--max-concurrent-tasks", "8",
    "--output", "json",
    "--error-limit", String(maxErrorCount),
    ...repoArgs,
  ];

  const { stdout, stderr, exitCode } = await runCommand("multi-gitter", args, {
    env: { ...process.env, GITHUB_TOKEN: opts.githubToken },
  });

  // multi-gitter exits 0 on full success, 1 on partial failures, 2+ on fatal
  if ((exitCode ?? 0) > 1) {
    throw new Error(
      `multi-gitter fatal exit ${exitCode}:\n${stderr.slice(-2000)}`,
    );
  }

  // Parse JSON output (one JSON object per line, or a single array)
  const prResults = parseMultiGitterOutput(stdout);
  return buildReport(body.target_repos, prResults, body.success_criteria, stderr);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveTitle(successCriteria: string): string {
  // Take first sentence / 80 chars
  const first = successCriteria.split(/[.\n]/)[0].trim();
  return first.length > 80 ? first.slice(0, 77) + "..." : first;
}

function parseMultiGitterOutput(raw: string): MultiGitterPRResult[] {
  const results: MultiGitterPRResult[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return results;

  // multi-gitter --output json writes one JSON object per line
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const obj = JSON.parse(l);
      // Handle both top-level array and single object
      if (Array.isArray(obj)) {
        results.push(...obj);
      } else {
        results.push(obj as MultiGitterPRResult);
      }
    } catch {
      // Not JSON — skip (multi-gitter can emit progress lines too)
    }
  }
  return results;
}

function buildReport(
  targeted: string[],
  results: MultiGitterPRResult[],
  successCriteria: string,
  stderr: string,
): MultiRepoRolloutReport {
  const prUrls: string[] = [];
  const succeeded: string[] = [];
  const failed: string[] = [];

  // Index results by repo slug
  const byRepo = new Map<string, MultiGitterPRResult>();
  for (const r of results) {
    if (r.repo) byRepo.set(r.repo, r);
  }

  for (const repo of targeted) {
    const r = byRepo.get(repo);
    if (!r) {
      // No result — treat as failure (guard will catch coverage gap)
      failed.push(repo);
      continue;
    }
    if (r.status === "created" || r.status === "already_exists") {
      succeeded.push(repo);
      if (r.url) prUrls.push(r.url);
    } else {
      failed.push(repo);
    }
  }

  const coverage = `${succeeded.length}/${targeted.length} repos succeeded`;
  const failedSummary =
    failed.length > 0 ? `\nFailed: ${failed.join(", ")}` : "";

  return {
    repos_targeted: targeted,
    repos_succeeded: succeeded,
    repos_failed: failed,
    pr_urls: prUrls,
    summary: `${coverage}. Criteria: ${successCriteria}${failedSummary}`,
    validation_evidence: buildEvidence(prUrls, stderr),
  };
}

function buildEvidence(prUrls: string[], stderr: string): string {
  const lines: string[] = [];
  if (prUrls.length > 0) {
    lines.push("PRs opened:");
    for (const url of prUrls) lines.push(`  ${url}`);
  }
  const stderrTail = stderr.slice(-500).trim();
  if (stderrTail) {
    lines.push("\nmulti-gitter stderr (tail):");
    lines.push(stderrTail);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// child_process wrapper
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCommand(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(cmd, args, {
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
    child.on("close", (code, signal) => {
      if (signal && !code) {
        reject(new Error(`${cmd} killed by signal ${signal}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Temp-file cleanup helper (call after invokeMultiGitter resolves/rejects)
// ---------------------------------------------------------------------------

/**
 * Remove the temp script written during invokeMultiGitter.
 * Pass the same workDir you passed in opts; ignored if workDir was undefined
 * (auto-generated dirs are not cleaned automatically — caller's choice).
 */
export function cleanupWorkDir(workDir: string): void {
  try {
    unlinkSync(join(workDir, "change.sh"));
  } catch {
    // best-effort
  }
}
