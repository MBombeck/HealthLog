/**
 * OpenAPI route table — Vorsorge (measurement) reminders (v1.17.1).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request
 * bodies come from the Zod validation module so the wire contract stays
 * single-source; the response DTO mirrors `src/lib/measurement-reminders/dto.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  createMeasurementReminderSchema,
  updateMeasurementReminderSchema,
  measurementReminderDto,
  measurementReminderCompletionDto,
  measurementReminderSkipDto,
  measurementReminderHistoryDto,
  snoozeMeasurementReminderSchema,
  listReminderHistorySchema,
} from "@/lib/validations/measurement-reminders";
import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  stdResponses,
} from "./shared";

const reminderNotFound = {
  "404": {
    description: "Measurement reminder not found / not owned.",
    content: { "application/json": { schema: errorEnvelope } },
  },
} as const;

export const measurementReminderPaths: NonNullable<ZodOpenApiObject["paths"]> =
  {
    "/api/measurement-reminders": {
      get: {
        tags: ["MeasurementReminders"],
        summary: "List Vorsorge reminders (v1.17.1)",
        description:
          "Returns the owner's live (non-tombstoned) Vorsorge reminders, sorted by server-computed nextDueAt ascending (nulls last). Each row carries the canonical nextDueAt the client renders without recomputing. Since v1.39.2 a check-up (a reminder with no measurementType) keeps its nextDueAt after its reminder is sent: an open check-up stays due, then overdue, until it is completed, skipped or snoozed, and the server repeats the reminder at most once a week while it stays open. A check-up on a weekly or shorter cadence, and a reminder with a measurementType, still roll on to the next slot after a delivered reminder.",
        responses: {
          ...recordRefusal(),
          "200": {
            description: "The owner's measurement reminders.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  z.array(measurementReminderDto),
                  "MeasurementReminderListEnvelope",
                ),
              },
            },
          },
          ...stdResponses,
        },
      },
      post: {
        tags: ["MeasurementReminders"],
        summary: "Create a Vorsorge reminder (v1.17.1)",
        description:
          "Creates a reminder and computes its server-authoritative nextDueAt. Exactly one of intervalDays (rolling) or rrule (RFC-5545) is required. Wrapped in withIdempotency. 201 on insert.",
        parameters: [idempotencyKeyParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: createMeasurementReminderSchema },
          },
        },
        responses: {
          ...idempotentWrite(),
          ...recordRefusal(),
          "201": {
            description: "Reminder created.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderDto,
                  "MeasurementReminderCreatedEnvelope",
                ),
              },
            },
          },
          ...stdResponses,
        },
      },
    },
    "/api/measurement-reminders/{id}": {
      get: {
        tags: ["MeasurementReminders"],
        summary: "Read a single Vorsorge reminder (v1.17.1)",
        description: "Owner-scoped; a cross-user or tombstoned id 404s.",
        requestParams: { path: z.object({ id: z.string() }) },
        responses: {
          ...recordRefusal(),
          "200": {
            description: "The reminder.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderDto,
                  "MeasurementReminderEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
      patch: {
        tags: ["MeasurementReminders"],
        summary: "Edit a Vorsorge reminder (v1.17.1)",
        description:
          "Partial edit; omitted fields are left untouched. nextDueAt is recomputed server-side after the cadence merge. Owner-scoped.",
        requestParams: { path: z.object({ id: z.string() }) },
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: updateMeasurementReminderSchema },
          },
        },
        responses: {
          ...recordRefusal(),
          "200": {
            description: "Reminder updated.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderDto,
                  "MeasurementReminderPatchEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
      delete: {
        tags: ["MeasurementReminders"],
        summary: "Soft-delete a Vorsorge reminder (v1.17.1)",
        description: "Sets deletedAt (tombstone). Idempotent. Owner-scoped.",
        requestParams: { path: z.object({ id: z.string() }) },
        responses: {
          ...recordRefusal(),
          "200": {
            description: "Soft-deleted.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  z.object({ deleted: z.boolean() }),
                  "MeasurementReminderDeleteEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
    },
    "/api/measurement-reminders/{id}/satisfy": {
      post: {
        tags: ["MeasurementReminders"],
        summary: "Mark a Vorsorge reminder done (v1.17.1)",
        description:
          "Manual 'Erledigt': stamps lastSatisfiedAt = now and recomputes nextDueAt past now. Free-text reminders resolve only through this path; typed reminders also auto-resolve in the cron when a matching reading lands.",
        requestParams: { path: z.object({ id: z.string() }) },
        responses: {
          ...recordRefusal(),
          "200": {
            description: "Reminder satisfied; next-due re-anchored.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderDto,
                  "MeasurementReminderSatisfyEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
    },
    "/api/measurement-reminders/{id}/complete": {
      post: {
        tags: ["MeasurementReminders"],
        summary: "Complete a Vorsorge reminder (v1.18.6)",
        description:
          "Explicit user-action completion (iOS #23): the app marks a reminder done server-side instead of only dismissing it locally. Routes through the same satisfaction primitive as the cron auto-resolve — stamps lastSatisfiedAt = now, re-anchors nextDueAt, fires no notification. Idempotent: completing an already-completed / auto-satisfied reminder returns 200 with completed=false. Owner-scoped.",
        requestParams: { path: z.object({ id: z.string() }) },
        responses: {
          ...recordRefusal(),
          "200": {
            description:
              "Completion applied (completed=true) or already-satisfied no-op (completed=false); reminder carries the canonical post-completion DTO.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderCompletionDto,
                  "MeasurementReminderCompleteEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
    },
    "/api/measurement-reminders/{id}/skip": {
      post: {
        tags: ["MeasurementReminders"],
        summary: "Skip the current due cycle (v1.37.20)",
        description:
          "Honestly skips the current due cycle — no body; the skip instant is the server clock. The interval restarts from the skip (rolling: skip + N days at the notify hour; rrule: next occurrence strictly after the skip), lastSkippedAt is stamped, skipCount incremented, any snooze cleared, and a SKIPPED row lands in the completion ledger. lastSatisfiedAt is never touched: a skip is not a completion. Screening reminders are skippable (the satisfy-side 409 guards claimed fulfilment; a skip claims the opposite). Owner-scoped; an appointment (encounter) reminder 404s.",
        requestParams: { path: z.object({ id: z.string() }) },
        responses: {
          ...recordRefusal(),
          "200": {
            description:
              "Skip applied (skipped=true) or forward-only no-op (skipped=false); reminder carries the canonical post-skip DTO.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderSkipDto,
                  "MeasurementReminderSkipEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
    },
    "/api/measurement-reminders/{id}/snooze": {
      post: {
        tags: ["MeasurementReminders"],
        summary: "Snooze to a calendar day (v1.37.20)",
        description:
          "Pushes the current due date back to a named calendar day (YYYY-MM-DD), resolved server-side to the reminder's notifyHour in the profile timezone. snoozedUntil and nextDueAt are set to the same instant, so every due-state consumer moves together and the cursor self-expires. The regular cadence is untouched — lastSatisfiedAt, lastSkippedAt and the anchor stay put. Must be at least tomorrow and at most five years out (422 otherwise). Repeated snoozes: last one wins. Owner-scoped; an appointment reminder 404s.",
        requestParams: { path: z.object({ id: z.string() }) },
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: snoozeMeasurementReminderSchema },
          },
        },
        responses: {
          ...recordRefusal(),
          "200": {
            description: "Snooze applied; reminder carries the resolved DTO.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  z.object({ reminder: measurementReminderDto }),
                  "MeasurementReminderSnoozeEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
    },
    "/api/measurement-reminders/{id}/history": {
      get: {
        tags: ["MeasurementReminders"],
        summary: "Completion ledger, newest first (v1.37.20)",
        description:
          "Paginated completion ledger for one reminder (iOS #68): one row per satisfy (from any path) and per skip, newest first. onTime is derived server-side at write time against the due instant that was current when the event landed. History begins at the release that introduced the ledger — the single-cursor engine holds nothing to backfill from. Owner-scoped; an appointment reminder 404s.",
        requestParams: {
          path: z.object({ id: z.string() }),
          query: listReminderHistorySchema,
        },
        responses: {
          ...recordRefusal(),
          "200": {
            description: "The reminder's completion ledger page.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  measurementReminderHistoryDto,
                  "MeasurementReminderHistoryEnvelope",
                ),
              },
            },
          },
          ...reminderNotFound,
          ...stdResponses,
        },
      },
    },
  };
