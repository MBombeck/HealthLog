/**
 * The by-external-ids deletes beside `DELETE /api/measurements/by-external-ids`:
 * the iPhone app's deletion reconciliation for workouts, ECG recordings, cycle
 * day-logs, State of Mind entries and dose records it imported from Apple
 * Health. One request shape, one response shape, one set of error codes
 * (`src/lib/sync/external-id-delete.ts`); what differs per domain is whether a
 * row is tombstoned or removed, which each description states.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  dataEnvelope,
  errorEnvelope,
  recordWriteRateLimitResponse,
  SHARING_NOT_PERMITTED_DESCRIPTION,
  stdResponses,
} from "./shared";

const request = z
  .object({
    externalIds: z.array(z.string().min(1).max(120)).max(500),
  })
  .strict()
  .meta({
    id: "ExternalIdDeleteRequest",
    description:
      "The externalIds of Apple Health samples the app no longer finds in HealthKit. At most 500; more is refused 422 with `meta.errorCode` `<domain>.delete.too_large`, a malformed body 422 with `<domain>.delete.invalid`. Duplicates in the list count once. An empty list answers `{ deletedCount: 0 }`.",
  });

const result = z
  .object({
    deletedCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Rows this call deleted. An id that matched nothing, matched a row of another source or account, or was already deleted is not counted.",
      ),
  })
  .meta({ id: "ExternalIdDeleteResult" });

const COMMON =
  "Only the caller's own rows with `source = APPLE_HEALTH` are matched; an id naming anything else is a no-op, never an error. Idempotent. Cookie session or a wildcard Bearer token (the native login); a narrow-scope token is refused 403. Metered by the shared per-account write bucket.";

function operation(args: {
  tag: string;
  summary: string;
  description: string;
  responseId: string;
  extraResponses?: Record<string, unknown>;
}) {
  return {
    delete: {
      tags: [args.tag],
      summary: args.summary,
      description: `${args.description} ${COMMON}`,
      requestBody: {
        required: true,
        content: { "application/json": { schema: request } },
      },
      responses: {
        "200": {
          description: "Delete batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(result, args.responseId),
            },
          },
        },
        ...stdResponses,
        ...recordWriteRateLimitResponse,
        ...(args.extraResponses ?? {}),
      },
    },
  };
}

export const externalIdDeletePaths: ZodOpenApiObject["paths"] = {
  "/api/workouts/by-external-ids": operation({
    tag: "Measurements",
    summary: "Delete Apple Health workouts by external ID",
    description:
      'Removes the workouts whose externalId is listed, with the personal records they set; the records are re-derived afterwards. The rows go outright, and since v1.48.2 every listed id is remembered: a later re-post of the same externalId to `POST /api/workouts/batch` answers `duplicate` with `reason: "tombstoned"` (since v1.49.0) and writes nothing, including an id that had not landed yet when the delete arrived. An id is remembered for 75 days, the tombstone retention every Apple Health delete shares; after that a re-post lands again.',
    responseId: "WorkoutsDeleteByExternalIdsResponse",
  }),
  "/api/insights/ecg/by-external-ids": operation({
    tag: "Insights",
    summary: "Delete Apple Health ECG recordings by external ID",
    description:
      'Removes the ECG recordings whose `externalRecordingId` (the id `POST /api/insights/ecg` stored) is listed, waveform included. A paired rhythm notification is a measurement of its own and stays. The rows go outright, and since v1.48.2 every listed id is remembered: a later re-post of the same id to `POST /api/insights/ecg` answers `duplicate` with `reason: "tombstoned"` (since v1.49.0) and writes nothing. An id is remembered for 75 days, the tombstone retention every Apple Health delete shares; after that a re-post lands again.',
    responseId: "EcgDeleteByExternalIdsResponse",
  }),
  "/api/cycle/day-logs/by-external-ids": operation({
    tag: "Cycle",
    summary: "Delete Apple Health cycle day-logs by external ID",
    description:
      "Soft-deletes the day-logs whose externalId is listed, each as `DELETE /api/cycle/day-logs/{id}` does: the tombstone reaches `/api/sync/changes`, and a day that opened a cycle takes that cycle with it, the cycle before it re-anchored. A later re-post of the same externalId through `POST /api/cycle/day-logs/bulk` writes the day again, since a day is fed by many samples; since v1.49.0 it starts from empty fields and no symptoms, so nothing the deleted day held comes back.",
    responseId: "CycleDayLogsDeleteByExternalIdsResponse",
    extraResponses: {
      "403": {
        description:
          "Cycle tracking is not enabled for this account (errorCode `cycle.disabled`).",
        content: { "application/json": { schema: errorEnvelope } },
      },
    },
  }),
  "/api/mood-entries/by-external-ids": operation({
    tag: "Mood",
    summary: "Delete Apple Health State of Mind entries by external ID",
    description:
      'Soft-deletes the mood entries posted with `source = APPLE_HEALTH` whose externalId is listed, each as `DELETE /api/mood-entries/{id}` does; the tombstone reaches `/api/sync/changes`. A mood logged in HealthLog itself is never touched. A later re-post of a deleted externalId stays deleted: `POST /api/mood-entries/bulk` answers `duplicate` with `reason: "tombstoned"` (since v1.49.0).',
    responseId: "MoodEntriesDeleteByExternalIdsResponse",
  }),
  "/api/symptoms/events/by-external-ids": operation({
    tag: "Symptoms",
    summary: "Delete Apple Health symptom occurrences by external ID",
    description:
      'Tombstones the symptom occurrences posted through `POST /api/symptoms/events/batch` whose externalId is listed. One logged in HealthLog is never touched. A later re-post of a deleted externalId stays deleted: the batch answers `duplicate` with `reason: "tombstoned"` (since v1.49.0). The tombstone is kept for 75 days, the retention every Apple Health delete shares. Owner-only: a session switched into another record is refused 403 `sharing.not_permitted`. Served when `GET /api/auth/me` reports `features.appleHealthSymptoms: true`.',
    responseId: "SymptomEventsDeleteByExternalIdsResponse",
    extraResponses: {
      "403": {
        description: `\`illness.disabled\`: the account has the illness module switched off (or the operator turned it off server-wide); symptoms ride that module.\n\n${SHARING_NOT_PERMITTED_DESCRIPTION}`,
        content: { "application/json": { schema: errorEnvelope } },
      },
    },
  }),
  "/api/medications/intake/by-external-ids": operation({
    tag: "Medications",
    summary: "Delete Apple Health dose records by external ID",
    description:
      'Soft-deletes the intake events posted with `source = APPLE_HEALTH` whose externalId (the HealthKit dose-event UUID) is listed, each as `DELETE /api/medications/{id}/intake/{eventId}` does: the stock it consumed is refunded, the tombstone reaches `/api/sync/changes`, and a one-shot medication whose only dose it was becomes active again. The caller\'s other devices get one silent intake-sync push (the device named by `x-device-id` is skipped). Since v1.49.0 a later re-post of the same externalId through `POST /api/medications/intake/bulk` is refused per entry, `duplicate` with `reason: "tombstoned"`, and writes nothing; so is the re-post of an Apple Health dose deleted in HealthLog itself. A fresh install that reads the whole Apple Health history therefore needs no list of deleted ids to skip. The tombstone is kept for 75 days, the retention every Apple Health delete shares.',
    responseId: "MedicationIntakesDeleteByExternalIdsResponse",
  }),
};
