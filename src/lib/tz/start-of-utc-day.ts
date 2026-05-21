/**
 * UTC-anchored start-of-day truncation shared by the measurement +
 * mood rollup writers.
 *
 * Both rollup tables store TIMESTAMPTZ bucket starts. Anchoring on the
 * UTC calendar day (rather than the user's local day) keeps the bucket
 * key deterministic across timezone-shifting consumers — the same
 * convention `date_trunc('day', measured_at AT TIME ZONE 'UTC')` would
 * produce on the read side. The display surfaces re-bucket into the
 * user's timezone via `userDayKey()` from `./format`.
 *
 * v1.4.40 W-GHOSTS consolidated two byte-identical local copies
 * (`src/lib/measurements/rollups.ts` + `src/lib/mood/rollups.ts`) into
 * this module so future writers cannot drift independently.
 */
export function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}
