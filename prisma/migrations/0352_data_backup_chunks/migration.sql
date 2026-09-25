-- Stored backups in pieces.
--
-- A backup used to be one `text` value in `data_backups.data`. One value has
-- to pass through the app as one value on its way in and out, so the largest
-- backup a host could keep was tied to the app's memory: a fifth of its heap
-- limit, 105 MB in the default 1 GB container, which an account with 1.75
-- million readings outgrew (#1031). A copy is now written as ordered pieces of
-- about a megabyte each, and nothing about its size depends on memory.
--
-- Additive for existing rows: a copy written before this migration keeps its
-- single value and stays readable as it is. The next weekly run replaces the
-- weekly copy in the new form; an uploaded copy keeps its old form until it is
-- deleted.

-- AlterTable
ALTER TABLE "data_backups" ALTER COLUMN "data" DROP NOT NULL,
ADD COLUMN     "chunk_count" INTEGER,
ADD COLUMN     "chunk_stream_id" TEXT;

-- CreateTable
CREATE TABLE "data_backup_chunks" (
    "id" TEXT NOT NULL,
    "backup_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "data_backup_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_backup_chunks_backup_id_seq_key" ON "data_backup_chunks"("backup_id", "seq");

-- AddForeignKey
ALTER TABLE "data_backup_chunks" ADD CONSTRAINT "data_backup_chunks_backup_id_fkey" FOREIGN KEY ("backup_id") REFERENCES "data_backups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ciphertext does not compress, so storing it uncompressed saves the attempt;
-- it still moves out of line like any large value.
ALTER TABLE "data_backup_chunks" ALTER COLUMN "data" SET STORAGE EXTERNAL;
