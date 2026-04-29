/**
 * Fleet watcher audit dashboard (DEV-506)
 *
 * Weekly view: auto-closed vs manual-closed fleet_watcher issues.
 * Drift signal: >5 manual-closed per week suggests the resolver is missing cases.
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { AUTO_CLOSED_MARKER } from "../services/fleet-regression-watcher.js";

export function fleetWatcherDashboardRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/fleet-watcher/audit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const weeksParam = Math.min(Number(req.query.weeks) || 12, 52);

    const rows = await db.execute<{
      week: string;
      auto_closed: number;
      manual_closed: number;
    }>(sql`
      WITH fleet_closed AS (
        SELECT
          i.id,
          date_trunc('week', COALESCE(i.cancelled_at, i.completed_at))::date AS week_start,
          CASE WHEN EXISTS (
            SELECT 1 FROM issue_comments ic
            WHERE ic.issue_id = i.id
              AND ic.body LIKE ${'%' + AUTO_CLOSED_MARKER + '%'}
          ) THEN 'auto' ELSE 'manual' END AS close_type
        FROM issues i
        WHERE i.company_id = ${companyId}
          AND i.origin_kind = 'fleet_watcher'
          AND i.status IN ('cancelled', 'done')
          AND COALESCE(i.cancelled_at, i.completed_at) >= NOW() - (${weeksParam} || ' weeks')::interval
      )
      SELECT
        to_char(week_start, 'IYYY-"W"IW') AS week,
        COUNT(*) FILTER (WHERE close_type = 'auto')::int AS auto_closed,
        COUNT(*) FILTER (WHERE close_type = 'manual')::int AS manual_closed
      FROM fleet_closed
      GROUP BY week_start
      ORDER BY week_start DESC
    `);

    const weeks = Array.from(rows);
    const driftWeeks = weeks.filter((w) => w.manual_closed > 5);

    res.json({
      weeks,
      driftSignal: driftWeeks.length > 0,
      driftWeeks: driftWeeks.map((w) => w.week),
    });
  });

  return router;
}
