-- v1.39 (C1) — the needs-based onboarding's per-record state.
--
-- One row per record (an account or a managed profile), created lazily by the
-- first answered step. Nothing here is encrypted: the three JSON columns hold
-- closed enum vocabularies rather than free text.
CREATE TABLE "onboarding_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "needs_json" JSONB,
    "steps_json" JSONB,
    "first_result_json" JSONB,
    "modules_derived_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onboarding_records_user_id_key" ON "onboarding_records"("user_id");

ALTER TABLE "onboarding_records" ADD CONSTRAINT "onboarding_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
