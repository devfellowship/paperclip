-- DEV-261: webhook_events table for audit/verification of inbound webhooks
-- Supports GET /api/companies/:id/webhook-events?source=github&repo=X&since=Y

CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"   uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source"       text NOT NULL,           -- "github"
  "event_type"   text NOT NULL,           -- x-github-event value, e.g. "workflow_run"
  "repo"         text,                    -- full repo name, e.g. "devfellowship/paperclip"
  "pr_number"    integer,
  "run_id"       bigint,
  "action"       text,                    -- payload.action
  "conclusion"   text,                    -- payload.workflow_run.conclusion
  "payload"      jsonb NOT NULL DEFAULT '{}',
  "received_at"  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webhook_events_company_id_idx"
  ON "webhook_events"("company_id");

CREATE INDEX IF NOT EXISTS "webhook_events_received_at_idx"
  ON "webhook_events"("received_at" DESC);

CREATE INDEX IF NOT EXISTS "webhook_events_repo_idx"
  ON "webhook_events"("repo");
