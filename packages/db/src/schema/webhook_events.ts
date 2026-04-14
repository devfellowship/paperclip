import { pgTable, uuid, text, integer, bigint, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DEV-261: Audit log of inbound webhook events received by Paperclip.
 * Enables agents to verify "did webhook X arrive?" without docker logs.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id:         uuid("id").primaryKey().defaultRandom(),
    companyId:  uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    source:     text("source").notNull(),      // "github"
    eventType:  text("event_type").notNull(),  // x-github-event value, e.g. "workflow_run"
    repo:       text("repo"),                  // full repo name "devfellowship/paperclip"
    prNumber:   integer("pr_number"),
    runId:      bigint("run_id", { mode: "bigint" }),
    action:     text("action"),                // payload.action
    conclusion: text("conclusion"),            // payload.workflow_run.conclusion
    payload:    jsonb("payload").notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx:  index("webhook_events_company_id_idx").on(table.companyId),
    receivedAtIdx: index("webhook_events_received_at_idx").on(table.receivedAt),
    repoIdx:       index("webhook_events_repo_idx").on(table.repo),
  }),
);
