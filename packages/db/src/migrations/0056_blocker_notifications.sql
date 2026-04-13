CREATE TABLE IF NOT EXISTS "blocker_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"blocker_hash" text NOT NULL,
	"summary" text NOT NULL,
	"needs" text NOT NULL,
	"context" text,
	"telegram_msg_id" bigint,
	"posted_at" timestamp with time zone DEFAULT now(),
	"resolved_at" timestamp with time zone,
	CONSTRAINT "blocker_notifications_task_id_blocker_hash_unique" UNIQUE("task_id","blocker_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blocker_notifications_task_id_idx" ON "blocker_notifications" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blocker_notifications_agent_id_idx" ON "blocker_notifications" USING btree ("agent_id");
