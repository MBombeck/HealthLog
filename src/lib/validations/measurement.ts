import { z } from "zod/v4";
import { EXTERNAL_SOURCE } from "@/lib/measurements/external-source";
import { validateEntryInstant } from "./entry-instant";
import { isCalendarDateKey } from "@/lib/tz/date-only";
import { isoDateTime } from "@/lib/validations/datetime";
import { MEASUREMENT_SOURCES } from "@/lib/measurements/sources";
import { MEASUREMENT_NOTES_MAX_LENGTH } from "@/lib/measurements/notes-limit";

export const measurementTypeEnum = z.enum([
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "BLOOD_GLUCOSE",
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "OXYGEN_SATURATION",
  // ── v1.4.23 Apple Health additions ──
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "ACTIVE_ENERGY_BURNED",
  "FLIGHTS_CLIMBED",
  "WALKING_RUNNING_DISTANCE",
  "VO2_MAX",
  "BODY_TEMPERATURE",
  // ── v1.4.25 W5d Withings full coverage ──
  "FAT_FREE_MASS",
  "FAT_MASS",
  "MUSCLE_MASS",
  "SKIN_TEMPERATURE",
  "PULSE_WAVE_VELOCITY",
  "VASCULAR_AGE",
  "VISCERAL_FAT",
  // ── v1.4.25 W8d Apple Health server-prep ──
  "AUDIO_EXPOSURE_ENV",
  "AUDIO_EXPOSURE_HEADPHONE",
  "TIME_IN_DAYLIGHT",
  // ── v1.4.30 R-F T1.4 + T1.5 ──
  "WALKING_STEADINESS",
  "AUDIO_EXPOSURE_EVENT",
  // ── v1.5.5 iOS-coord — six previously-deferred HK identifiers wired end-to-end ──
  "RESPIRATORY_RATE",
  "BODY_MASS_INDEX",
  "LEAN_BODY_MASS",
  "WALKING_HEART_RATE_AVERAGE",
  "WALKING_ASYMMETRY",
  "WALKING_DOUBLE_SUPPORT",
  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ──
  // Both ship raw SI on the wire (metres / metres-per-second); see
  // the convention block in `apple-health-mapping.ts`.
  "WALKING_STEP_LENGTH",
  "WALKING_SPEED",
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // Seven previously-deferred quantity identifiers; each ships raw on
  // the wire (identity conversion). See the convention block in
  // `apple-health-mapping.ts`.
  "CARDIO_RECOVERY",
  "WRIST_TEMPERATURE",
  "FALL_COUNT",
  "SIX_MINUTE_WALK_DISTANCE",
  "STAIR_ASCENT_SPEED",
  "STAIR_DESCENT_SPEED",
  "BREATHING_DISTURBANCES",
  // ── v1.10.0 — categorical events (WX-B) ──
  // Discrete device-flagged EVENT rows (value is always 1). The device's
  // own verdict / severity rides in the `rhythmClassification` column.
  "IRREGULAR_RHYTHM_NOTIFICATION",
  "HIGH_HEART_RATE_EVENT",
  "LOW_HEART_RATE_EVENT",
  "WALKING_STEADINESS_EVENT",
  "BREATHING_DISTURBANCE_EVENT",
  // ── v1.10.0 — computed scores (WX-C) ──
  // Server-derived wellness scores (0–100, unit `score`). Minted by a
  // nightly engine from the user's already-stored signals and persisted as a
  // `COMPUTED`-source row — never ingested from a client (the batch +
  // single-POST write surfaces reject the COMPUTED source). Only
  // RECOVERY_SCORE is computed in v1.10.0; the other two are defined now so
  // the later engines that compute them need no schema change.
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
  // ── v1.11.0 — WHOOP-native score classes (additive) ──
  // Native WHOOP scores ingest server-side as `source = WHOOP`. DAY_STRAIN /
  // HRV_RMSSD are deliberately distinct from STRAIN_SCORE / SDNN
  // HEART_RATE_VARIABILITY so a device-native value never shares a bucket
  // with a derived proxy. See `apple-health-mapping.ts` convention block and
  // `.planning/v1.11-build/epic-A-whoop-buildspec.md` §3.2.
  "HRV_RMSSD",
  "DAY_STRAIN",
  "WORKOUT_STRAIN",
  "SLEEP_PERFORMANCE",
  "SLEEP_EFFICIENCY",
  "SLEEP_CONSISTENCY",
  "SLEEP_NEED",
  "ENERGY_EXPENDITURE_KJ",
  // ── v1.12.8 — WHOOP cycle + sleep coverage completion (additive) ──
  // Daily average / max heart rate ride WHOOP's cycle score (previously
  // fetched but dropped). Kept distinct from spot PULSE / RESTING_HEART_RATE /
  // WALKING_HEART_RATE_AVERAGE: these are the day's whole-cycle aggregates,
  // not a point-in-time or context-specific reading. Sleep disturbance count
  // is the per-night WHOOP `stage_summary.disturbance_count`.
  "AVERAGE_HEART_RATE",
  "MAX_HEART_RATE",
  "SLEEP_DISTURBANCE_COUNT",
  // v1.17.1 — Polar Nightly Recharge + Training Load Pro components ingested
  // server-side as `source = POLAR`. ANS_CHARGE is the HRV-based autonomic
  // charge (distinct from the 1–6 recovery band that maps to RECOVERY_SCORE);
  // CARDIO_LOAD is Polar's device-native cardiovascular-strain figure (distinct
  // from WHOOP DAY_STRAIN and the COMPUTED STRAIN_SCORE).
  "ANS_CHARGE",
  "CARDIO_LOAD",
  // ── v1.17.1 — Oura coverage completion (additive) ──
  // Oura's headline 0–100 Sleep Score (`daily_sleep.score`), distinct from the
  // WHOOP SLEEP_PERFORMANCE / SLEEP_EFFICIENCY sub-scores. The body-temperature
  // deviation is a SIGNED °C offset from the user's baseline
  // (`daily_readiness.temperature_deviation`), not an absolute reading, so it
  // never shares the BODY_TEMPERATURE / SKIN_TEMPERATURE / WRIST_TEMPERATURE
  // buckets. Both ingest server-side as `source = OURA`.
  "SLEEP_SCORE",
  "BODY_TEMPERATURE_DEVIATION",
  // ── v1.19.0 — Oura resilience (additive) ──
  // Oura's daily resilience LEVEL (`daily_resilience.level`) — a categorical
  // band (limited / adequate / solid / strong / exceptional) ORDINAL-ENCODED
  // into the numeric value (limited=1 … exceptional=5), unit `level`. Ingests
  // server-side as `source = OURA`. See `RESILIENCE_LEVELS` in `src/lib/oura/client`.
  "RESILIENCE",
  // ── v1.25 — clinical-signals wave ──
  // PHQ-9 / GAD-7 derived total scores (one row per completed administration;
  // value = total). The raw item answers never ride a Measurement row — they
  // stay in the encrypted MentalHealthAssessment blob.
  "PHQ9_SCORE",
  "GAD7_SCORE",
  // Grip strength (kg), pain Numeric Rating Scale (0–10), waist circumference
  // (cm) + waist-to-height ratio. First-class numeric clinical signals; bands
  // applied at the display edge from the signal registry.
  "GRIP_STRENGTH",
  "PAIN_NRS",
  "WAIST_CIRCUMFERENCE",
  "WAIST_TO_HEIGHT",
  // ── v1.27.9 — screening scores (same assessment contract as PHQ-9/GAD-7,
  // inverted direction: HIGHER is better). WHO-5 stores the reported 0–100
  // percentage (raw sum × 4); SCI stores the 0–32 total.
  "WHO5_SCORE",
  "SCI_SCORE",
  // ── v1.44 — Apple Health activity rings, mindfulness, State of Mind and
  // AFib burden. See the enum comments in `prisma/schema.prisma`.
  "EXERCISE_MINUTES",
  "STAND_MINUTES",
  "STAND_HOURS",
  "MINDFUL_MINUTES",
  "STATE_OF_MIND_VALENCE",
  "AFIB_BURDEN",
  // ── v1.44 — room climate pushed through the ingest token ──
  "INDOOR_CO2",
  "INDOOR_TEMPERATURE",
  "INDOOR_HUMIDITY",
]);

/**
 * v1.10.0 — categorical events (WX-B). The closed set of EVENT-class
 * MeasurementTypes. An EVENT row carries `value = 1`, an optional
 * `rhythmClassification` verdict, and never participates in trend / rollup
 * analytics (it is a discrete occurrence, not a continuous reading). Kept
 * as a `Set` so ingest + read paths can branch on "is this an event row?".
 */
export const EVENT_MEASUREMENT_TYPES: ReadonlySet<string> = new Set<string>([
  "IRREGULAR_RHYTHM_NOTIFICATION",
  "HIGH_HEART_RATE_EVENT",
  "LOW_HEART_RATE_EVENT",
  "WALKING_STEADINESS_EVENT",
  "BREATHING_DISTURBANCE_EVENT",
]);

export const glucoseContextEnum = z.enum([
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
]);

export const measurementSourceEnum = z.enum(MEASUREMENT_SOURCES);

/**
 * v1.10.0 — computed scores (WX-C). The subset of `MeasurementSource` a
 * client may attribute on a write. `COMPUTED` is server-owned (a nightly
 * engine mints it) and `WITHINGS` / `IMPORT` are owned by the Withings
 * webhook + CSV importer respectively, so all three are excluded — letting a
 * client forge a row attributed to them would pollute the per-source
 * canonical picker with rows the server never produced. The single-entry
 * POST validates `source` against this set; the batch route mirrors the same
 * exclusion with its own narrower `{APPLE_HEALTH, MANUAL}` allowlist.
 */
export const WRITABLE_MEASUREMENT_SOURCES = ["MANUAL", "APPLE_HEALTH"] as const;

/**
 * v1.10.0 — the Zod enum the single-entry POST validates `source` against.
 * Built from `WRITABLE_MEASUREMENT_SOURCES` so the allowlist has one source of
 * truth. A client may only attribute a row it actually owns: `MANUAL` (a
 * hand-entered reading) or `APPLE_HEALTH` (the HealthKit batch's per-row
 * source). `WITHINGS` is owned by the Withings webhook, `IMPORT` by the CSV
 * importer, and `COMPUTED` by the nightly score engines — letting a client
 * forge any of those would pollute the per-source canonical picker with rows
 * the server never produced. The batch route mirrors the same exclusion with
 * its own narrower `{APPLE_HEALTH, MANUAL}` `batchSourceEnum`.
 */
export const writableMeasurementSourceEnum = z.enum(
  WRITABLE_MEASUREMENT_SOURCES,
);

/**
 * v1.38.x — the subset of `MeasurementSource` whose VALUE the owner may still
 * edit after the fact. A strictly different question from the one
 * `WRITABLE_MEASUREMENT_SOURCES` answers, and the two are kept apart on
 * purpose:
 *
 *   - writable  = "may a client ASSERT this source on a write?"
 *   - correctable = "is the number this row carries the user's own to fix?"
 *
 * `EXTERNAL` is no on the first and yes on the second. A client naming it
 * would be forging provenance, so it stays out of the write allowlist — which
 * `/api/meta/capabilities` publishes as `ingest.writeAllowlist`, so widening
 * that constant would tell every client the source is theirs to claim. But the
 * hardware behind an ingest token is the user's own scale, not a provider's
 * reading: the 409 that protects a Withings row ("the value is the provider's,
 * editing it would forge a row the server never received") has no force here,
 * and locking these rows would contradict what the settings card and the
 * Home Assistant guide both promise.
 *
 * Read at exactly one call site — the value-edit gate in
 * `PUT /api/measurements/[id]`. Everything else keeps reading
 * `WRITABLE_MEASUREMENT_SOURCES`; folding the two back together re-conflates
 * the questions above.
 */
export const USER_CORRECTABLE_MEASUREMENT_SOURCES = [
  ...WRITABLE_MEASUREMENT_SOURCES,
  EXTERNAL_SOURCE,
] as const;

// The canonical unit per type lives in a Zod-free module so the client's
// display transform can read it without pulling Zod into every chart route.
export { getUnitForType } from "@/lib/measurements/unit-map";

// The plausibility band per type, and its check, live in a Zod-free module so
// the client's value-domain reads (the chart floor, the integer set) do not
// pull Zod into every metric page.
import { validateMeasurementRange } from "@/lib/measurements/value-ranges";
export {
  VALUE_RANGES,
  validateMeasurementRange,
} from "@/lib/measurements/value-ranges";

export const createMeasurementSchema = z
  .object({
    type: measurementTypeEnum,
    value: z.number(),
    // v1.17 — plausibility bound (shared `validateEntryInstant`): no
    // future instants beyond a 5-min clock-skew tolerance, no instant before
    // 1900. Closes the data-portability gap where a hand-rolled POST could
    // backdate or forward-date a reading arbitrarily.
    measuredAt: validateEntryInstant(
      isoDateTime().transform((s) => new Date(s)),
    ),
    notes: z.string().max(MEASUREMENT_NOTES_MAX_LENGTH).optional(),
    // v1.10.0 — validate against the client-writable subset, not the full
    // `MeasurementSource` enum. A client may attribute only `MANUAL` or
    // `APPLE_HEALTH`; `WITHINGS` / `IMPORT` / `COMPUTED` are server-owned and
    // forging them would pollute the per-source canonical picker.
    source: writableMeasurementSourceEnum.optional().default("MANUAL"),
    // Only applies when type === BLOOD_GLUCOSE. The "not on any other type"
    // half is mirrored by a CHECK constraint in Postgres (migrations 0021 +
    // 0274). The "required on a glucose row" half below is a rule of THIS
    // schema only — see the refine.
    glucoseContext: glucoseContextEnum.optional(),
    // v1.4.25 (code-review M4): the single-entry POST
    // dropped `deviceType` silently because the column existed on
    // `Measurement` and was accepted by the batch route, but never
    // declared in this schema. iOS clients that POST one row at a
    // time (and dashboards that backfill manual rows with device
    // metadata) now persist the tag instead of seeing it disappear.
    // Accepts `null` so a client can explicitly clear the column.
    deviceType: z.string().min(1).max(32).nullable().optional(),
    // v1.18.6 — optional "I feel unwell with this reading" flag. Transient
    // (NOT persisted on the measurement row): it only lifts a confirmed
    // safety-floor escalation from the asymptomatic "contact your doctor"
    // copy to the symptom-coupled emergency copy. Defaults to false/absent —
    // every existing client keeps the asymptomatic posture. Never a diagnosis.
    symptomsPresent: z.boolean().optional(),
  })
  .refine((data) => validateMeasurementRange(data.type, data.value) === null, {
    message: "Value out of plausible range",
  })
  // Deliberately asymmetric with the bulk ingest paths. This schema backs the
  // hand-entry surface, where a person is present at the reading and knows
  // whether it was fasting, after a meal, random or at bedtime — the form
  // always offers the choice, so requiring it costs nothing and keeps the
  // per-context breakdowns meaningful. A sensor or meter export has no such
  // answer per sample, so the CSV import, the JSON import and the device sync
  // paths accept a contextless reading and store NULL rather than guessing.
  // Absence stays absence; it is never widened into a classification.
  .refine(
    (data) =>
      (data.type === "BLOOD_GLUCOSE" && data.glucoseContext !== undefined) ||
      (data.type !== "BLOOD_GLUCOSE" && data.glucoseContext === undefined),
    {
      message:
        "Blood glucose measurements require a context (fasting/postprandial/random/bedtime); other types must not set one.",
      path: ["glucoseContext"],
    },
  );

export const updateMeasurementSchema = z.object({
  // No generic magnitude bound here: the route validates the new value
  // against the row's OWN type through `validateMeasurementRange` after the
  // lookup (the schema cannot know the type — the edit body doesn't carry
  // it). The former `min(0)` also blocked legitimate edits of the signed
  // types (ANS_CHARGE, BODY_TEMPERATURE_DEVIATION).
  value: z.number().optional(),
  // v1.17 — same plausibility bound on the edit path; an edit cannot
  // forward-date a reading into the future nor before 1900.
  measuredAt: validateEntryInstant(
    isoDateTime().transform((s) => new Date(s)),
  ).optional(),
  notes: z
    .string()
    .max(
      MEASUREMENT_NOTES_MAX_LENGTH,
      `Note cannot exceed ${MEASUREMENT_NOTES_MAX_LENGTH} characters`,
    )
    .nullable()
    .optional(),
});

/**
 * Query params for `GET /api/personal-records`.
 *
 * Both fields used to be parsed defensively at the route: an unrecognised
 * `metricType` was dropped (which WIDENED the read to every metric rather
 * than narrowing it, so a typo returned more data than asked for) and a
 * garbage `limit` reverted to the default. Neither told the caller anything,
 * so a typo was indistinguishable from an omission. Both are refused now.
 *
 * The 500 ceiling matches every other paginated read on the surface, and it
 * refuses rather than clamps for the same reason: silently serving 500 rows
 * to a caller that asked for 999 999 is another difference nobody is told
 * about.
 */
export const listPersonalRecordsSchema = z.object({
  metricType: measurementTypeEnum.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

export const listMeasurementsSchema = z
  .object({
    type: measurementTypeEnum.optional(),
    from: isoDateTime()
      .transform((s) => new Date(s))
      .optional(),
    to: isoDateTime()
      .transform((s) => new Date(s))
      .optional(),
    // v1.4.28 — when the chart sends an explicit from/to window the
    // payload is already bounded; lift the per-request ceiling to 5000
    // (still cheaper than the legacy unbounded `while (true)` walk).
    // Callers that omit from/to keep the historical 500-row cap.
    limit: z.coerce.number().int().min(1).max(5000).optional().default(100),
    offset: z.coerce.number().int().min(0).optional().default(0),
    sortBy: z
      .enum(["type", "value", "measuredAt", "source"])
      .optional()
      .default("measuredAt"),
    sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
    // v1.4.28 — bucket hint for range-aware queries. When set the
    // GET handler runs a server-side `date_trunc` aggregation and returns
    // one row per bucket per type rather than the raw measurement rows.
    // Omitting `aggregate` keeps the raw wire shape (iOS contract); the
    // chart-data client must opt in explicitly.
    aggregate: z.enum(["raw", "daily", "weekly", "monthly"]).optional(),
    // v1.4.36 — opt-in source switch for daily-aggregate reads. When
    // `source=rollup` + `aggregate=daily`, the route reads from the
    // persistent `measurement_rollups` DAY buckets instead of running a
    // live `date_trunc` GROUP BY scan over the raw `measurements` table.
    // The chart-data client opts in for the trends-row strip + every
    // sub-page chart so the three parallel daily-aggregate requests stop
    // burning a full table scan each. The route falls back to live SQL
    // when the rollup bucket set is empty for the requested window so
    // brand-new accounts still see correct data on their first chart.
    source: z.enum(["rollup"]).optional(),
    // v1.15.13 — management-list source FILTER. The `source` key above is
    // the rollup-tier opt-in (`["rollup"]`), NOT a source filter, so the
    // filter rides a distinct param. Validated against `MeasurementSource`;
    // threaded into the plain-list `where`. Backed by the `(userId, source,
    // measuredAt)` index (migration 0136).
    sourceEq: measurementSourceEnum.optional(),
    // Only the rows the HealthLog app writes into Apple Health
    // (`appleHealthMirror`, #1272): the app's historical backfill pages this
    // instead of one fetch per source. A plain-list filter.
    appleHealthMirror: z.enum(["true"]).optional(),
    // v1.18.5 — value-range FILTER (backlog G). Narrows the plain list to
    // readings whose `value` falls within an optional `[valueMin, valueMax]`
    // band. Either bound may be omitted for an open-ended range. Coerced
    // from the query string; threaded into the plain-list `where` as a
    // `value: { gte, lte }` range. Server-authoritative; validated min<=max.
    valueMin: z.coerce.number().finite().optional(),
    valueMax: z.coerce.number().finite().optional(),
    // v1.4.37 — list-view "one row per day" mode for cumulative
    // types (steps, active energy, distance, flights, daylight). When
    // `groupBy=day` is set and `type` is a cumulative HK type, the route
    // returns one synthesised row per user-TZ day with `value` = SUM
    // and `sampleCount` = number of per-sample rows behind the bucket.
    // Omitted = legacy per-sample list behaviour (iOS contract stable).
    //
    // v1.43.6 — `limit` / `offset` page over DAYS on this mode: the route
    // picks the page's local days in Postgres and reports the distinct-day
    // count as `meta.total` (#1245).
    groupBy: z.enum(["day"]).optional(),
    // v1.4.37 — drill-down to per-sample rows for a single day in
    // the user's IANA timezone. Format `YYYY-MM-DD`; the route resolves
    // the day boundary against the user's `User.timezone`. Used by the
    // expandable list row to reveal the chunks that contributed to the
    // collapsed daily total.
    //
    // v1.4.37 — a drill-down returns one bounded page rather than a
    // cursor, so it refuses a non-zero `offset`.
    dayKey: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "dayKey must be YYYY-MM-DD")
      // v1.4.37 — a `YYYY-MM-DD` string can satisfy the regex while
      // still being an impossible calendar date (`2026-02-30`,
      // `2026-13-01`). `new Date("2026-02-30T00:00:00Z")` silently
      // overflows to March 2, so the drill-down would return rows from
      // a different day than the user asked for. The same helper feeds
      // the admin drain route, so a malformed CLI invocation has the
      // same blast radius. Reject the impossible shapes at the
      // validator instead.
      .refine(
        isCalendarDateKey,
        "dayKey must be a real calendar date (YYYY-MM-DD)",
      )
      .optional(),
  })
  .refine(({ offset, dayKey }) => !(offset > 0 && dayKey != null), {
    message:
      "offset is not supported with dayKey; a drill-down returns the whole day",
    path: ["offset"],
  })
  // v1.4.38 — surface the drill-down cap on the validator so a caller
  // asking for more than 1000 rows on a per-day branch sees a 422
  // instead of a silent `Math.min(limit, 1000)` clamp inside the
  // route. The drill-down returns at most one phone-only stepCount
  // day's worth of per-sample chunks; 1000 covers the pathological
  // case with room to spare. Callers that want a wider window should
  // omit `dayKey` and use `from` / `to` instead.
  .refine(({ limit, dayKey }) => !(dayKey != null && limit > 1000), {
    message:
      "limit must be <= 1000 when dayKey is set; drill-down responses are capped at 1000 rows",
    path: ["limit"],
  })
  // A value range filters single readings, and a day-grouped row is the sum
  // of a whole day: filtering its readings would return partial days summed
  // as if they were whole. The combination has no honest answer, so it is
  // refused rather than served.
  .refine(
    ({ groupBy, valueMin, valueMax }) =>
      groupBy !== "day" || (valueMin == null && valueMax == null),
    {
      message:
        "valueMin / valueMax filter single readings and cannot be combined with groupBy=day",
      path: ["groupBy"],
    },
  )
  // v1.18.5 — an inverted value range (`valueMin > valueMax`) is a client
  // bug, not an empty result set; reject it at the validator with a 422 so
  // the filter UI can surface the mismatch instead of silently returning
  // zero rows. Open-ended ranges (one bound omitted) pass through.
  .refine(
    ({ valueMin, valueMax }) =>
      valueMin == null || valueMax == null || valueMin <= valueMax,
    {
      message: "valueMin must be <= valueMax",
      path: ["valueMin"],
    },
  )
  // `appleHealthMirror` narrows the plain row list. The other modes answer
  // something else (night rows, day buckets, a drill-down, a series), where
  // a row filter would either do nothing or change what the mode means.
  .refine(
    ({ appleHealthMirror, type, dayKey, groupBy, aggregate, source }) =>
      appleHealthMirror === undefined ||
      (type !== "SLEEP_DURATION" &&
        dayKey === undefined &&
        groupBy === undefined &&
        source === undefined &&
        (aggregate === undefined || aggregate === "raw")),
    {
      message:
        "appleHealthMirror filters the plain row list only; combine it with type, from, to, sourceEq and paging",
      path: ["appleHealthMirror"],
    },
  );

export const createBatchMeasurementSchema = z.object({
  measurements: z.array(createMeasurementSchema).min(1).max(5),
});

export type CreateMeasurementInput = z.infer<typeof createMeasurementSchema>;
export type CreateBatchMeasurementInput = z.infer<
  typeof createBatchMeasurementSchema
>;
export type UpdateMeasurementInput = z.infer<typeof updateMeasurementSchema>;
export type ListMeasurementsInput = z.infer<typeof listMeasurementsSchema>;
