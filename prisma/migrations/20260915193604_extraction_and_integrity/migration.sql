-- CreateTable
CREATE TABLE "extraction_run" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DECIMAL(10,4),
    "error" TEXT,

    CONSTRAINT "extraction_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_row" (
    "id" TEXT NOT NULL,
    "extractionRunId" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3),
    "type" TEXT,
    "amount" DECIMAL(14,2),
    "balanceAfter" DECIMAL(14,2),
    "sourceFrameTs" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,

    CONSTRAINT "transaction_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation" (
    "id" TEXT NOT NULL,
    "extractionRunId" TEXT NOT NULL,
    "wageredTotal" DECIMAL(14,2) NOT NULL,
    "grantedAmount" DECIMAL(14,2),
    "delta" DECIMAL(14,2),
    "arithmeticOk" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrity_flag" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "detail" TEXT,
    "generatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrity_flag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "extraction_run_submissionId_idx" ON "extraction_run"("submissionId");

-- CreateIndex
CREATE INDEX "transaction_row_extractionRunId_idx" ON "transaction_row"("extractionRunId");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_row_extractionRunId_rowKey_key" ON "transaction_row"("extractionRunId", "rowKey");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_extractionRunId_key" ON "reconciliation"("extractionRunId");

-- CreateIndex
CREATE INDEX "integrity_flag_submissionId_idx" ON "integrity_flag"("submissionId");

-- CreateIndex
CREATE INDEX "integrity_flag_code_idx" ON "integrity_flag"("code");

-- AddForeignKey
ALTER TABLE "extraction_run" ADD CONSTRAINT "extraction_run_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_row" ADD CONSTRAINT "transaction_row_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "extraction_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation" ADD CONSTRAINT "reconciliation_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "extraction_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_flag" ADD CONSTRAINT "integrity_flag_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
