-- Why a document has no preview thumbnail. The boot-time backfill skips a
-- document whose render failed for good, until the document changes.
CREATE TABLE "document_thumbnail_failures" (
    "document_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "failed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_thumbnail_failures_pkey" PRIMARY KEY ("document_id")
);

CREATE INDEX "document_thumbnail_failures_user_id_idx"
    ON "document_thumbnail_failures"("user_id");

ALTER TABLE "document_thumbnail_failures"
    ADD CONSTRAINT "document_thumbnail_failures_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "inbound_documents"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_thumbnail_failures"
    ADD CONSTRAINT "document_thumbnail_failures_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
