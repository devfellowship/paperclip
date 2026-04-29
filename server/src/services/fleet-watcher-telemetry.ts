/**
 * Fleet watcher telemetry (DEV-506)
 *
 * Provides:
 *  - OTel counter `fleet_watcher.auto_closed_total{reason}` incremented on each auto-close.
 *  - Structured audit log emitting the full auto-close payload via pino.
 */

import { metrics } from "@opentelemetry/api";
import { logger } from "../middleware/logger.js";

const meter = metrics.getMeter("fleet_watcher");

const autoClosedCounter = meter.createCounter("fleet_watcher.auto_closed_total", {
  description: "Total number of fleet-watcher auto-closed issues",
});

export type AutoCloseReason =
  | "pr-absent"
  | "main-green-streak";

export interface AutoCloseAuditPayload {
  issueId: string;
  githubRepo: string;
  githubPrNumber: number | null;
  reason: AutoCloseReason;
  evidence: string;
}

/**
 * Record an auto-close event: increments the OTel counter and writes a
 * structured audit log entry with the full payload.
 */
export function recordAutoClose(payload: AutoCloseAuditPayload): void {
  autoClosedCounter.add(1, { reason: payload.reason });

  logger.info(
    {
      event: "fleet_watcher.auto_closed",
      issueId: payload.issueId,
      githubRepo: payload.githubRepo,
      githubPrNumber: payload.githubPrNumber,
      reason: payload.reason,
      evidence: payload.evidence,
    },
    "fleet-watcher: issue auto-closed",
  );
}
