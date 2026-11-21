/**
 * OpenAPI route table — the scheduled doctor report: whether and how often
 * the record's doctor report is filed into the document vault on its own.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * schema comes from `src/lib/validations/report-schedule.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { REPORT_SCHEDULE_OUTCOMES } from "@/lib/doctor-report/schedule-shape";
import {
  reportScheduleCadenceEnum,
  reportSchedulePutSchema,
  reportScheduleWindowEnum,
} from "@/lib/validations/report-schedule";
import { isoDateTime } from "@/lib/validations/datetime";

import { dataEnvelope, malformedJsonResponse, stdResponses } from "./shared";

const reportScheduleView = z
  .object({
    cadence: reportScheduleCadenceEnum,
    window: reportScheduleWindowEnum,
    lastPeriod: z
      .string()
      .nullable()
      .describe(
        "The last period a run settled: `2026-10`, `2026-Q3` or `2025`. Null before the first run.",
      ),
    lastOutcome: z
      .enum(REPORT_SCHEDULE_OUTCOMES)
      .nullable()
      .describe(
        "How the last run ended. `stored`: filed. `alreadyFiled`: the vault already held this period's report. `deletedByOwner`: the owner deleted it, so it is not filed again. `quotaExceeded` / `tooLarge`: it did not fit the vault; the next period tries again. `noSelection`: no saved report selection to render, retried once there is one. `failed`: retried on the next run.",
      ),
    lastRunAt: isoDateTime().nullable(),
    duePeriod: z
      .string()
      .nullable()
      .describe(
        "The closed period the next run files, on the record's clock; null when it is already settled.",
      ),
  })
  .meta({
    id: "ReportSchedule",
    description:
      "The scheduled doctor report. Each closed period is rendered with the owner's saved report selection and filed once into the document vault as a `DOCTOR_REPORT` document with `sourceSystem: REPORT_SCHEDULE` and `sourceId: <cadence>:<period>`. No notification is sent.",
  });

const reportScheduleStatus = z.object({
  schedule: reportScheduleView.nullable(),
});

export const reportSchedulePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/settings/report-schedule": {
    get: {
      tags: ["Records"],
      summary: "Scheduled doctor report status",
      description:
        "The schedule of the record the caller manages; `schedule` is null while it is off (the default).",
      responses: {
        "200": {
          description: "The status.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                reportScheduleStatus,
                "ReportScheduleStatus",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Records"],
      summary: "Turn the scheduled doctor report on or change it",
      description:
        "`cadence` is MONTHLY, QUARTERLY or YEARLY; `window` is the closed period itself (PERIOD) or the last 90 or 365 days up to its end. A changed cadence clears the stamps, so the latest closed period of the new cadence is filed on the next hourly run; an unchanged one keeps them. Refused with 403 `module.disabled` while the `doctorReport` module is off.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: reportSchedulePutSchema.meta({
              id: "ReportSchedulePut",
              description: "The cadence and the window.",
            }),
          },
        },
      },
      responses: {
        "200": {
          description: "The status after the change.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                reportScheduleStatus,
                "ReportScheduleStatusAfterPut",
              ),
            },
          },
        },
        ...malformedJsonResponse,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Turn the scheduled doctor report off",
      description: "Reports already filed stay in the vault.",
      responses: {
        "200": {
          description: "Off; `schedule` is null.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                reportScheduleStatus,
                "ReportScheduleStatusAfterDelete",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
