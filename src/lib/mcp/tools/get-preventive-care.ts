import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { capped, cappedOutput } from "@/lib/mcp/capped";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";
import { calendarDaysUntil } from "@/lib/measurement-reminders/due-day";
import { fenceUserText, scrubFenceMarkers } from "@/lib/ai/coach/data-fence";
import { decryptVisitText } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/**
 * Output schema for `get_preventive_care` — the Vorsorge due-list, plus the
 * upcoming appointments booked as visits.
 *
 * `appointments` is a NAMED field on this same result rather than a second
 * due-list tool: an assistant asked "what is coming up" gets one answer instead
 * of having to know there are two lists. The Vorsorge `checkups` arm stays free
 * of `ENCOUNTER`-origin reminders (the query excludes them); the appointments are
 * read from `Encounter` directly, so the two never blur.
 */
const getPreventiveCareOutput: z.ZodRawShape = {
  present: z.boolean(),
  checkups: z
    .array(
      z.object({
        label: z.string(),
        measurementType: z.string().nullable(),
        nextDueAt: z.string().nullable(),
        overdue: z.boolean(),
        location: z.string().nullable(),
        lastSatisfiedAt: z.string().nullable(),
        // #223: resolved skip/snooze state. Without these the
        // model sees a due date jump with no cause and invents one.
        // `lastSatisfiedAt` stays the ONLY completed signal: a skip is
        // recorded as a skip, never as done.
        snoozedUntil: z.string().nullable(),
        lastSkippedAt: z.string().nullable(),
        skipCount: z.number(),
      }),
    )
    .optional(),
  appointments: z
    .array(
      z.object({
        occurredAt: z.string(),
        practitioner: z.string().nullable(),
        specialty: z.string().nullable(),
        kind: z.string(),
        reason: z.string().nullable(),
      }),
    )
    .optional(),
  appointmentsTruncated: cappedOutput.truncated.describe(
    "True when more booked appointments exist than `appointments` lists: the list was cut at `appointmentsLimit`, soonest first. Say the list is partial.",
  ),
  appointmentsLimit: cappedOutput.limit.describe(
    "The most appointments this result could list.",
  ),
};

/** Newest-first cap on the appointments folded into `get_preventive_care`. */
const MAX_APPOINTMENTS = 25;

export const getPreventiveCareTool: McpToolDefinition = {
  name: "get_preventive_care",
  title: "Get preventive-care due-list",
  description:
    "Fetch what preventive care is coming up: the user's own configured preventive-care (Vorsorge) reminders (upcoming and overdue checkups with their next-due dates) AND the appointments they have booked as future visits. Surfaces only the reminders the user has already set up (it never invents screening recommendations); each checkup carries its label, optional measurement type, next-due instant, an overdue flag, and last-completed date. Each `appointments` entry carries its date, practitioner name + specialty, visit kind, and the visit's own free-text reason. Returns { present: false } only when neither a reminder nor an appointment exists.",
  inputShape: {},
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getPreventiveCareOutput,
  async run(ctx) {
    const now = new Date();
    // Upcoming appointments ride alongside the Vorsorge due-list, read from
    // `Encounter` (a booked visit in the future). They are a NAMED field on
    // this result, not a second tool, so "what is coming up" is one answer.
    const { rows: appointmentRows, cap: appointmentCap } = await capped(
      MAX_APPOINTMENTS,
      (take) =>
        prisma.encounter.findMany({
          where: {
            userId: ctx.userId,
            deletedAt: null,
            status: "PLANNED",
            occurredAt: { gt: now },
          },
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          take,
          include: {
            practitioner: { select: { name: true, specialty: true } },
          },
        }),
    );
    const appointments = appointmentRows.map((r) => {
      const reason = decryptVisitText(r.reasonEncrypted);
      // A live visit names its practitioner even after the address-book
      // entry is deleted, as the web record does.
      const practitioner = r.practitioner;
      return {
        occurredAt: r.occurredAt.toISOString(),
        practitioner: practitioner
          ? scrubFenceMarkers(practitioner.name)
          : null,
        specialty: practitioner?.specialty
          ? scrubFenceMarkers(practitioner.specialty)
          : null,
        kind: r.kind,
        // A visit's reason is user- and document-derived free text, so it
        // rides the same USER_TEXT wrapping every other free-text field uses.
        reason: reason !== null ? fenceUserText(reason) : null,
      };
    });

    const reminders = await prisma.measurementReminder.findMany({
      // A booked visit's one-shot reminder rides this same engine with
      // `origin: ENCOUNTER`. It is not a checkup and must not appear on a
      // Vorsorge surface, or the list fills with appointments. Four read
      // sites carry this exclusion; `encounter-reminder-exclusion.test.ts`
      // proves every one of them, and the DTO mapper refuses such a row
      // outright so a site that lost its filter fails loudly.
      where: {
        userId: ctx.userId,
        deletedAt: null,
        enabled: true,
        origin: { not: "ENCOUNTER" },
      },
      // Most-urgent first; a null next-due (uncomputable) sinks to the end.
      orderBy: [
        { nextDueAt: { sort: "asc", nulls: "last" } },
        { createdAt: "asc" },
      ],
    });
    // Present when EITHER arm carries something: a person with a booked
    // appointment but no configured Vorsorge reminder still has preventive
    // care coming up, and hiding the appointment behind `present: false`
    // would be the silent-zero this contract forbids.
    if (reminders.length === 0 && appointments.length === 0) {
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_preventive_care", present: false },
      });
      return { present: false };
    }

    // Overdue is a CALENDAR-day verdict, the same one the checkups screen
    // renders. Comparing the instants said a checkup booked for nine this
    // morning was overdue by ten past, so the tool called something overdue
    // on the very day it is due while the screen next to it read "today".
    const user = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { timezone: true },
    });
    const timezone = user?.timezone || DEFAULT_TIMEZONE;
    const checkups = reminders.map((r) => {
      const dto = toMeasurementReminderDto(r);
      return {
        // Label and location are the user's own free text — same fencing
        // the sibling appointment `reason` carries, so a forged marker in
        // a reminder cannot impersonate the fence around its neighbours.
        label: fenceUserText(dto.label),
        measurementType: dto.measurementType,
        nextDueAt: dto.nextDueAt,
        overdue:
          dto.nextDueAt !== null
            ? calendarDaysUntil(new Date(dto.nextDueAt), now, timezone) < 0
            : false,
        location: dto.location !== null ? fenceUserText(dto.location) : null,
        lastSatisfiedAt: dto.lastSatisfiedAt,
        // Timestamps + a counter, no free text — nothing to fence here.
        snoozedUntil: dto.snoozedUntil,
        lastSkippedAt: dto.lastSkippedAt,
        skipCount: dto.skipCount,
      };
    });

    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_preventive_care", present: true },
    });
    return {
      present: true,
      ...(checkups.length > 0 ? { checkups } : {}),
      ...(appointments.length > 0
        ? {
            appointments,
            // The cap describes the appointments only; the checkups are
            // read whole.
            appointmentsTruncated: appointmentCap.truncated,
            appointmentsLimit: appointmentCap.limit,
          }
        : {}),
    };
  },
};
