-- CreateTable
CREATE TABLE "participant" (
    "id" TEXT NOT NULL,
    "contact" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollment" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "casino" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'invited',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_request" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "dropboxRequestId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "destinationPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_asset" (
    "id" TEXT NOT NULL,
    "blobKey" TEXT NOT NULL,
    "mime" TEXT,
    "bytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mediaAssetId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "supersededBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dropbox_cursor" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "cursor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dropbox_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrollment_participantId_idx" ON "enrollment"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "file_request_dropboxRequestId_key" ON "file_request"("dropboxRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "media_asset_blobKey_key" ON "media_asset"("blobKey");

-- CreateIndex
CREATE UNIQUE INDEX "media_asset_contentHash_key" ON "media_asset"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "submission_mediaAssetId_key" ON "submission"("mediaAssetId");

-- CreateIndex
CREATE INDEX "submission_enrollmentId_idx" ON "submission"("enrollmentId");

-- CreateIndex
CREATE INDEX "submission_receivedAt_idx" ON "submission"("receivedAt");

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_request" ADD CONSTRAINT "file_request_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
