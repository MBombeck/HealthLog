/**
 * The `features` block of the account payload (`GET /api/auth/me`), kept
 * beside the payload schema in `account-sharing.ts`.
 */
import { z } from "zod/v4";

export const accountFeaturesBlock = z
  .object({
    trackIntake: z
      .literal(true)
      .describe(
        "Medications take `trackIntake`: a medication can be kept as a record whose doses are never due, and a dose written against one is refused with `medication.intake.notTracked`.",
      ),
    cumulativeHourBuckets: z
      .boolean()
      .optional()
      .describe(
        "v1.43 — `POST /api/measurements/batch` takes hourly `stats:<HK>:<YYYY-MM-DD>T<HH>` rows for steps, active energy, walking and running distance and flights climbed. Send them only when this is `true`: an older server stores every hour as its own measurement.",
      ),
    syncTriggerBackfill: z
      .boolean()
      .optional()
      .describe(
        'v1.43 — `syncTrigger: "backfill"` is accepted on the measurement batch and the intake bulk. Send it only when this is `true`: an older server refuses the whole batch.',
      ),
    biomarkerMerge: z
      .boolean()
      .optional()
      .describe("v1.43 — `POST /api/biomarkers/{id}/merge` is available."),
    lifeCircumstances: z
      .boolean()
      .optional()
      .describe(
        "v1.43 — the life-circumstances routes under `/api/anamnesis/life-circumstances` and `/api/anamnesis/audit-c` are available.",
      ),
    appleHealthSymptoms: z
      .boolean()
      .optional()
      .describe(
        "v1.48.2 — `POST /api/symptoms/events/batch` with the built-in symptom codes and `DELETE /api/symptoms/events/by-external-ids` are available. Send Apple Health symptoms only when this is `true`.",
      ),
    appleHealthDeletes: z
      .boolean()
      .optional()
      .describe(
        'v1.48.2 — the by-external-ids deletes for workouts, ECG recordings, cycle day-logs, mood entries and medication doses are available, and mood-entry writes take `source: "APPLE_HEALTH"` with an `externalId`. The routes shipped in v1.48.0; since v1.48.2 a deleted Apple Health workout or ECG recording also stays deleted when the same sample is posted again (`duplicate`).',
      ),
    nutrientMacros: z
      .boolean()
      .optional()
      .describe(
        "v1.48.2 — `POST /api/nutrients/batch` takes the macro codes (energy, protein, carbohydrates, the fats, sugar, fibre, cholesterol, sodium, potassium). The codes shipped in v1.48.0.",
      ),
  })
  .describe(
    "What this server understands, for a client released apart from it. Constant across accounts. A flag that is absent or `false` means this server does not have the feature; a client checks for `true` before it calls a route or sends a request form the flag names. Absent on servers older than v1.42.0. A client that meets a flag it does not know ignores it.",
  );
