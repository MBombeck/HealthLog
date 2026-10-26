-- Give every PDF preview that failed to rasterize one more render.
--
-- Until this release the server could load two pdf.js versions. Once a local
-- text read had claimed the in-process pdf.js worker, every later page render
-- failed until a restart, and the thumbnail job recorded those documents as
-- `raster-failed`. The backfill treats that reason as final, so their previews
-- would never be tried again.
--
-- Only `raster-failed`: the clash surfaced as a rasterization that returned a
-- failure, and the thumbnail path maps that to this reason and to no other.
-- `error` comes from a throw, and the rasterizer never throws; `empty-render`
-- and `pixel-cap` are decided after a render that worked.
--
-- A stored failure cannot say whether the clash caused it or the page really
-- renders blank, so every such row goes. The boot-time thumbnail backfill
-- finds each document again, renders it once, and a page that is really blank
-- records `raster-failed` with one attempt and settles where it was. Running
-- this again costs one more render per such document and nothing else.
DELETE FROM "document_thumbnail_failures"
 WHERE "reason" = 'raster-failed';
