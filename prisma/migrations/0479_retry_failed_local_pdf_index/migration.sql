-- Queue one more content-index attempt for every PDF whose last one failed in
-- a way a pdf.js clash produces.
--
-- Until this release the server could load two pdf.js versions. Once a page
-- render had claimed the in-process pdf.js worker, every later local text read
-- failed until a restart, which the index records as `decrypt-error`; the
-- other way round, a scanned PDF the picked provider could only read as images
-- failed to rasterize and was recorded as `raster-failed`. Neither document has
-- a content index, so neither is found by search, and on an instance without a
-- configured AI provider nothing offers to index it again.
--
-- The marker is the state no index attempt ever leaves behind: a failure
-- reason with no attempt time (the recorder always writes both). The boot
-- discovery `document-index-retry` enqueues the auto-index job for exactly
-- those rows, through the same provider-first, local-fallback decision and the
-- same consent rules as an upload. The attempt writes its time back, so the
-- row drops out whatever the outcome: a document that really cannot be read
-- records its reason again and stays settled.
--
-- Only PDFs without an index and with a recorded attempt are touched; running
-- this again queues those that failed once more for one more attempt.
UPDATE "inbound_documents" AS d
   SET "last_index_attempt_at" = NULL
 WHERE d."deleted_at" IS NULL
   AND d."mime_type" = 'application/pdf'
   AND d."last_index_outcome" IN ('decrypt-error', 'raster-failed')
   AND d."last_index_attempt_at" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM "document_content_index" AS c
      WHERE c."document_id" = d."id"
   );
