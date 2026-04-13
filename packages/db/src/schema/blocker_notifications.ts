import { pgTable, serial, text, bigint, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const blockerNotifications = pgTable(
  "blocker_notifications",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id").notNull(),
    agentId: text("agent_id").notNull(),
    blockerHash: text("blocker_hash").notNull(),
    summary: text("summary").notNull(),
    needs: text("needs").notNull(),
    context: text("context"),
    telegramMsgId: bigint("telegram_msg_id", { mode: "bigint" }),
    postedAt: timestamp("posted_at", { withTimezone: true }).defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    taskIdIdx: index("blocker_notifications_task_id_idx").on(table.taskId),
    agentIdIdx: index("blocker_notifications_agent_id_idx").on(table.agentId),
    taskBlockerUnique: uniqueIndex("blocker_notifications_task_id_blocker_hash_unique").on(
      table.taskId,
      table.blockerHash,
    ),
  }),
);
