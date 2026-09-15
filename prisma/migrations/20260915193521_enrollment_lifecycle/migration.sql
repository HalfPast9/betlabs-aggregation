-- CreateTable
CREATE TABLE "email_evidence" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "dkimResult" TEXT NOT NULL,
    "selector" TEXT,
    "dDomain" TEXT,
    "publicKeyUsed" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "hTagCoversTo" BOOLEAN NOT NULL,
    "lTagPresent" BOOLEAN NOT NULL,
    "fromAddr" TEXT,
    "toAddr" TEXT,
    "subject" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dkim_allowed_signer" (
    "id" TEXT NOT NULL,
    "casino" TEXT NOT NULL,
    "domain" TEXT NOT NULL,

    CONSTRAINT "dkim_allowed_signer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "evidenceSnapshot" JSONB NOT NULL,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_evidence_submissionId_key" ON "email_evidence"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "dkim_allowed_signer_casino_domain_key" ON "dkim_allowed_signer"("casino", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "grant_enrollmentId_key" ON "grant"("enrollmentId");

-- CreateIndex
CREATE INDEX "decision_enrollmentId_at_idx" ON "decision"("enrollmentId", "at");

-- AddForeignKey
ALTER TABLE "email_evidence" ADD CONSTRAINT "email_evidence_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant" ADD CONSTRAINT "grant_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision" ADD CONSTRAINT "decision_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
