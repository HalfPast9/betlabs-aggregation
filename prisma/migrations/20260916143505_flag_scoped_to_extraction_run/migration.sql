-- AlterTable
ALTER TABLE "integrity_flag" ADD COLUMN     "extractionRunId" TEXT;

-- CreateIndex
CREATE INDEX "integrity_flag_extractionRunId_idx" ON "integrity_flag"("extractionRunId");

-- AddForeignKey
ALTER TABLE "integrity_flag" ADD CONSTRAINT "integrity_flag_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "extraction_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
