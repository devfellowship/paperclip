CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN IF NOT EXISTS "embedded_at" TIMESTAMPTZ;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN IF NOT EXISTS "embedding_model" TEXT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_decision_records_embedding_hnsw" ON "decision_records" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
