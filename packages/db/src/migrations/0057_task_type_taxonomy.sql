-- Harness v2 Fase 1.1/1.2 — Task type taxonomy columns (DEV-167)
-- Adds task_type, task_body, and completion_report to the issues table.
-- Decision: dedicated task_type text column (queryable, explicit) over metadata->>task_type.
-- JSONSchemas are hardcoded in server/src/services/task-types.ts for now.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "task_type" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "task_body" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "completion_report" jsonb;
