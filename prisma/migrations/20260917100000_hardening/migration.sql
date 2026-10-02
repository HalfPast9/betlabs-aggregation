ALTER TABLE "extraction_run"
  ADD COLUMN "quality" JSONB,
  ADD COLUMN "retryTiles" INTEGER,
  ADD COLUMN "crossCheckModel" TEXT;

ALTER TABLE "transaction_row"
  ADD COLUMN "crossChecked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "disagreements" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
