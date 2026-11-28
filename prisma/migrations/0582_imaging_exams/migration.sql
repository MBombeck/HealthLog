-- Imaging exams (#1672): one row per exam (MRI, CT, X-ray, ultrasound,
-- mammography, other) and the link table that files the report and the
-- pictures from the document vault against it.
--
-- Free text (body part, facility, requesting doctor, conclusion) is sealed at
-- rest in BYTEA columns through the shared codec; there is no plaintext twin.
--
-- Purely additive: two types and two tables, nothing existing changes shape,
-- nothing to backfill. Every statement is guarded, the foreign keys included,
-- so a lock-timeout retry runs the file again without a change.
-- Reversibility: dropping the two tables and the two types restores the
-- previous schema.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'imaging_modality') THEN
        CREATE TYPE "imaging_modality" AS ENUM ('MRI', 'CT', 'X_RAY', 'ULTRASOUND', 'MAMMOGRAPHY', 'OTHER');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'imaging_side') THEN
        CREATE TYPE "imaging_side" AS ENUM ('LEFT', 'RIGHT', 'BOTH');
    END IF;

    CREATE TABLE IF NOT EXISTS "imaging_exams" (
        "id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "modality" "imaging_modality" NOT NULL,
        "performed_at" TIMESTAMP(3) NOT NULL,
        "side" "imaging_side",
        "body_part_encrypted" BYTEA,
        "facility_encrypted" BYTEA,
        "requesting_doctor_encrypted" BYTEA,
        "conclusion_encrypted" BYTEA,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "imaging_exams_pkey" PRIMARY KEY ("id")
    );

    CREATE INDEX IF NOT EXISTS "imaging_exams_user_id_performed_at_idx" ON "imaging_exams"("user_id", "performed_at");

    CREATE TABLE IF NOT EXISTS "imaging_exam_document_links" (
        "id" TEXT NOT NULL,
        "exam_id" TEXT NOT NULL,
        "document_id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "imaging_exam_document_links_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "imaging_exam_document_links_exam_id_document_id_key" ON "imaging_exam_document_links"("exam_id", "document_id");
    CREATE INDEX IF NOT EXISTS "imaging_exam_document_links_document_id_idx" ON "imaging_exam_document_links"("document_id");
    CREATE INDEX IF NOT EXISTS "imaging_exam_document_links_user_id_idx" ON "imaging_exam_document_links"("user_id");

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'imaging_exams_user_id_fkey') THEN
        ALTER TABLE "imaging_exams"
            ADD CONSTRAINT "imaging_exams_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'imaging_exam_document_links_exam_id_fkey') THEN
        ALTER TABLE "imaging_exam_document_links"
            ADD CONSTRAINT "imaging_exam_document_links_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "imaging_exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'imaging_exam_document_links_document_id_fkey') THEN
        ALTER TABLE "imaging_exam_document_links"
            ADD CONSTRAINT "imaging_exam_document_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "inbound_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'imaging_exam_document_links_user_id_fkey') THEN
        ALTER TABLE "imaging_exam_document_links"
            ADD CONSTRAINT "imaging_exam_document_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
