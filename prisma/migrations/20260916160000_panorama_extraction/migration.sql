-- ExtractionRun: scroll-reconstruction bookkeeping
ALTER TABLE "extraction_run"
  ADD COLUMN "frameCount" INTEGER,
  ADD COLUMN "tileCount" INTEGER,
  ADD COLUMN "panoramaBlobKey" TEXT;

-- TransactionRow: identity by position, not content
ALTER TABLE "transaction_row"
  ADD COLUMN "sequence" INTEGER,
  ADD COLUMN "segmentIndex" INTEGER,
  ADD COLUMN "panoramaTop" DOUBLE PRECISION,
  ADD COLUMN "panoramaBottom" DOUBLE PRECISION,
  ADD COLUMN "partial" BOOLEAN NOT NULL DEFAULT false;

-- Backfill sequence for rows from pre-panorama runs (frame order, then insertion).
UPDATE "transaction_row" t
SET "sequence" = s.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "extractionRunId" ORDER BY "sourceFrameTs", id) - 1 AS rn
  FROM "transaction_row"
) s
WHERE t.id = s.id;

ALTER TABLE "transaction_row" ALTER COLUMN "sequence" SET NOT NULL;

DROP INDEX "transaction_row_extractionRunId_rowKey_key";
CREATE UNIQUE INDEX "transaction_row_extractionRunId_sequence_key" ON "transaction_row"("extractionRunId", "sequence");
CREATE INDEX "transaction_row_rowKey_idx" ON "transaction_row"("rowKey");

-- Reconciliation: balance-chain verification
ALTER TABLE "reconciliation"
  ADD COLUMN "chainComplete" BOOLEAN,
  ADD COLUMN "chainBreaks" JSONB,
  ADD COLUMN "chainStart" DECIMAL(14,2),
  ADD COLUMN "chainEnd" DECIMAL(14,2),
  ADD COLUMN "newestFirst" BOOLEAN;
