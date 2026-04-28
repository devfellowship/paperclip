-- Conditionally enable pgvector and add embedding columns.
-- Entire block is skipped if decision_records table doesn't exist (e.g. embedded-postgres CI).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'decision_records'
  ) THEN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
      CREATE EXTENSION IF NOT EXISTS vector;
      ALTER TABLE "decision_records" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
      CREATE INDEX IF NOT EXISTS "idx_decision_records_embedding_hnsw"
        ON "decision_records" USING hnsw ("embedding" vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
    END IF;
    ALTER TABLE "decision_records" ADD COLUMN IF NOT EXISTS "embedded_at" TIMESTAMPTZ;
    ALTER TABLE "decision_records" ADD COLUMN IF NOT EXISTS "embedding_model" TEXT;
  END IF;
END $$;
