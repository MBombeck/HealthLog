/**
 * The backup plan's DERIVED register, kept apart from `backup-plan.ts` (which
 * re-exports it) so the plan stays under the size ratchet.
 */
/**
 * Recomputable from backed-up rows. The reason names what rebuilds it, so a
 * future reader can check the claim rather than trust it.
 */
export const DERIVED_MODELS: Readonly<Record<string, string>> = {
  MeasurementRollup:
    "A per-day, per-metric reconstruction of `Measurement`. The boot-time rollup backfill rebuilds it for an account that has none.",
  MoodEntryRollup:
    "A per-day reconstruction of `MoodEntry`, rebuilt by the same rollup tier that rebuilds the measurement one.",
  MoodPrediction:
    "What the account's own past days imply about a day, fitted from `MoodEntry` + `MoodContext` and the linked modules. The nightly `mood-prognosis-refresh` job rebuilds it after a restore, and rebuilding it is better than carrying it: a restored row would state a forecast made by a model version that may no longer exist, against data the restore has just moved.",
  CyclePrediction:
    "A forecast derived from `MenstrualCycle` history; regenerated on the next cycle read.",
  StrainTrimpCache:
    "A cache of a pure function over `Workout` and heart-rate samples.",
  WorkoutInsight:
    "Generated narrative over `Workout`; regenerates on demand. Carrying it would restore an interpretation of data rather than the data.",
  WorkoutInsightGenerationClaim:
    "A concurrency claim and the daily-cap ledger for the generator above. It outlives a deleted workout for at most a week and means nothing on another instance or day.",
  InsightNarrative:
    "Generated prose over measurements. Same reasoning as WorkoutInsight — the record restores, the essay about it does not.",
  InsightStatusCache:
    "Regenerable cache: the per-metric status notes a model wrote over measurements, rewritten by the nightly run. Same reasoning as InsightNarrative.",
  DocumentContentIndex:
    "A search index over `InboundDocument` text; rebuilt by the indexer.",
  DocumentThumbnail:
    "Rendered from the stored document bytes on demand. Those bytes travel in a disaster-recovery payload, so the picture rebuilds itself on first view; a portable export carries metadata only, and there the thumbnail has nothing to rebuild from — but neither does the document, so nothing is lost that the export did not already disclose.",
  DocumentThumbnailFailure:
    "Why a document's preview could not be rendered on this host, kept so the boot backfill stops retrying it. The receiving host renders the restored document itself, and its own failure, if any, writes the row again; carrying this one would stop a host whose renderer can draw the page from ever trying.",
  ArrivalReaction:
    "Derived from what changed since the last visit; recomputed per visit.",
  DismissedPriorityItem:
    "A per-item dismissal of a recomputed priority list. The list regenerates; a stale dismissal would suppress an item the new list means to raise.",
};
