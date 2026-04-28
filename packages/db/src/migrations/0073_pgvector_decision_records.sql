-- Conditionally enable pgvector and add embedding columns.
-- Wrapped in a DO block so embedded-postgres (no vector extension) can skip
-- the vector-dependent DDL without failing the whole migration.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE "decision_records" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
    CREATE INDEX IF NOT EXISTS "idx_decision_records_embedding_hnsw"
      ON "decision_records" USING hnsw ("embedding" vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  END IF;
  -- Non-vector columns are always added regardless of extension availability
  ALTER TABLE "decision_records" ADD COLUMN IF NOT EXISTS "embedded_at" TIMESTAMPTZ;
  ALTER TABLE "decision_records" ADD COLUMN IF NOT EXISTS "embedding_model" TEXT;
END $$;
