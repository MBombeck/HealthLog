/**
 * The marker HealthLog's iOS app stamps on every HealthKit sample it writes
 * itself, next to `HKExternalUUID` (the HealthLog row id): a manual entry saved
 * from the app, and any Withings, import or manual row the server-to-Health
 * mirror writes. Builds from before the marker existed wrote the id alone.
 *
 * Such a sample is usually already in the database under its own source. When
 * it comes back through an Apple Health export it is a second copy of that
 * reading, so the export import leaves it out, but only once its
 * `HKExternalUUID` names a row of the importing account (a cycle sample: once
 * that account holds a day-log on its day). The marker alone says HealthLog
 * wrote the sample, not that this instance still holds it: after a move to a
 * new instance without a backup, the export is how those values come back.
 *
 * This is not the predicate the app's own sync uses. The app decides "our own
 * echo" from `HKExternalUUID` plus the sample's authoring source being the app
 * itself (`HealthKitSampleOwnership.isOwnEcho`); it keeps this marker for the
 * deletion path, where a deleted object exposes its metadata but no source. An
 * export names its source only by a display name, so the import cannot repeat
 * the source check and reads the marker instead, and for samples from before
 * the marker, `HKExternalUUID` against the account's own row ids. The key and
 * value are a stable contract with the app.
 */
export const HEALTHLOG_ORIGIN_METADATA_KEY = "dev.healthlog.app.origin";
export const HEALTHLOG_ORIGIN_METADATA_VALUE = "healthlog";

/** Is this `<MetadataEntry>` the mark of a sample HealthLog wrote itself? */
export function isHealthLogOriginEntry(
  key: string | undefined,
  value: string | undefined,
): boolean {
  return (
    key === HEALTHLOG_ORIGIN_METADATA_KEY &&
    value === HEALTHLOG_ORIGIN_METADATA_VALUE
  );
}
