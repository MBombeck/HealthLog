-- Document import (#1038). Two optional provenance columns on the vault, a
-- per-user unique source key that covers tombstoned rows too, and a small
-- ledger the purge fills so a re-run importer cannot bring back a deleted
-- document after its tombstone is gone. Existing rows keep NULL and are not
-- touched by the index.
ALTER TABLE "inbound_documents"
  ADD COLUMN "source_system" VARCHAR(16),
  ADD COLUMN "source_id" VARCHAR(128);

-- Partial unique index (documented in schema.prisma; Prisma cannot express a
-- partial index). No `deleted_at` predicate on purpose: a tombstoned document
-- still owns its source key.
CREATE UNIQUE INDEX "inbound_documents_user_source_key"
  ON "inbound_documents" ("user_id", "source_system", "source_id")
  WHERE "source_id" IS NOT NULL;

CREATE TABLE "document_import_keys" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "source_system" VARCHAR(16) NOT NULL,
  "source_id" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_import_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_import_keys_user_id_source_system_source_id_key"
  ON "document_import_keys" ("user_id", "source_system", "source_id");

ALTER TABLE "document_import_keys"
  ADD CONSTRAINT "document_import_keys_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Imports held back from automatic AI reading (`aiRead=defer`). The summary
-- catch-up, the summary job and lab auto-staging skip a row that carries it.
ALTER TABLE "inbound_documents"
  ADD COLUMN "ai_read_deferred" BOOLEAN NOT NULL DEFAULT false;

-- Further source keys an import answered with an existing document (same
-- bytes under another key). The purge copies them into the ledger above.
CREATE TABLE "document_source_aliases" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "source_system" VARCHAR(16) NOT NULL,
  "source_id" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_source_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_source_aliases_user_id_source_system_source_id_key"
  ON "document_source_aliases" ("user_id", "source_system", "source_id");

CREATE INDEX "document_source_aliases_document_id_idx"
  ON "document_source_aliases" ("document_id");

ALTER TABLE "document_source_aliases"
  ADD CONSTRAINT "document_source_aliases_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_source_aliases"
  ADD CONSTRAINT "document_source_aliases_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "inbound_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
