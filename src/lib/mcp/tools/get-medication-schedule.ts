import { z } from "zod/v4";
import { medicationWindow } from "@/lib/medications/course-window";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { loadAutoTakeRollingAnchors } from "@/lib/medications/auto-take";
import {
  computeDisplayDue,
  OVERDUE_LOOKBACK_MS,
  toResolvedSlotMark,
  type ResolvedSlotMark,
} from "@/lib/medications/scheduling/next-due";
import { dueSchedules } from "@/lib/medications/intake-tracking";
import { liveEraStartsByMedication } from "@/lib/medications/scheduling/live-era";
import { MODULE_DISABLED } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";
import { MEDICATION_SCHEDULE_ORDER } from "@/lib/medications/read-order";

// ── Operational reads (not Coach snapshot domains) ──────────────────
// These answer "what should I do / why is my data stale" rather than "what
// are my figures". They are NOT in the Coach data inventory (which enumerates
// metric domains); each is a thin façade over an existing server-authoritative
// engine — the medication recurrence engine, the integration-status ledger,
// and the persisted Vorsorge reminder due dates — and never recomputes.

/** Output schema for `get_medication_schedule` — per-medication next-due. */
const getMedicationScheduleOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  medications: z
    .array(
      z.object({
        name: z.string(),
        dose: z.string().nullable(),
        nextDueAt: z.string().nullable(),
        overdue: z.boolean(),
        asNeeded: z.boolean(),
        intakeTracked: z.boolean(),
      }),
    )
    .optional(),
};

export const getMedicationScheduleTool: McpToolDefinition = {
  name: "get_medication_schedule",
  title: "Get the medication schedule",
  description:
    'Fetch when the user\'s active medications are next due, and which are overdue right now. Reuses the same server-authoritative recurrence engine the medication cards render (open overdue slots win over future ones). Returns one row per active medication: name, dose, next-due instant, an overdue flag, an as-needed (PRN) flag, and an intakeTracked flag. As-needed medications and medications whose intake tracking is off (intakeTracked: false, kept as a record only) have no due time (nextDueAt: null). Returns { present: false } when no medications are tracked, and { present: false, reason: "module_disabled" } when the medications module is switched off.',
  inputShape: {},
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getMedicationScheduleOutput,
  async run(ctx) {
    if (!(await isModuleEnabled(ctx.userId, "medications"))) {
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: {
          tool: "get_medication_schedule",
          present: false,
          refused: "module_disabled",
        },
      });
      return MODULE_DISABLED;
    }
    const now = new Date();
    const [user, medications] = await Promise.all([
      prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { timezone: true },
      }),
      prisma.medication.findMany({
        where: { userId: ctx.userId, active: true },
        include: { schedules: { orderBy: MEDICATION_SCHEDULE_ORDER } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    ]);

    if (medications.length === 0) {
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_medication_schedule", present: false },
      });
      return { present: false };
    }

    const userTz = user?.timezone || DEFAULT_TIMEZONE;

    // Same feeder reads + horizon the medications list route / dashboard
    // builder use, so the open-overdue detection matches the in-app cards.
    const resolvedWindowStart = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);
    const resolvedWindowEnd = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const [latestIntakes, resolvedEvents, eraFloors] = await Promise.all([
      prisma.medicationIntakeEvent.groupBy({
        by: ["medicationId"],
        where: {
          userId: ctx.userId,
          deletedAt: null,
          skipped: false,
          takenAt: { not: null },
        },
        _max: { takenAt: true },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: {
          userId: ctx.userId,
          deletedAt: null,
          scheduledFor: { gte: resolvedWindowStart, lte: resolvedWindowEnd },
          OR: [
            { takenAt: { not: null } },
            { skipped: true },
            { autoMissed: true },
          ],
        },
        select: { medicationId: true, scheduledFor: true, takenAt: true },
      }),
      prisma.medicationScheduleRevision.groupBy({
        by: ["medicationId"],
        where: {
          medication: { userId: ctx.userId },
          supersededByRevisionId: null,
        },
        _max: { validUntil: true },
      }),
    ]);

    const lastTakenAtByMedId = new Map<string, Date | null>(
      latestIntakes.map((e) => [e.medicationId, e._max.takenAt]),
    );
    const resolvedSlotsByMedId = new Map<string, ResolvedSlotMark[]>();
    for (const e of resolvedEvents) {
      const mark = toResolvedSlotMark(e);
      const list = resolvedSlotsByMedId.get(e.medicationId);
      if (list) list.push(mark);
      else resolvedSlotsByMedId.set(e.medicationId, [mark]);
    }
    // The live era start per medication (see `live-era.ts`).
    const eraStartByMedId = liveEraStartsByMedication(eraFloors);

    // Under auto-take a rolling cadence stands where the job
    // will record next (see `auto-take.ts`).
    const engineLastIntakeAt = await loadAutoTakeRollingAnchors(prisma, {
      userId: ctx.userId,
      medicationIds: medications
        .filter((m) => m.autoMarkTaken)
        .map((m) => m.id),
      now,
      userTz,
      lastIntakeAt: (id) => lastTakenAtByMedId.get(id) ?? null,
    });

    const rows = medications.map((m) => {
      const display = computeDisplayDue({
        medication: {
          id: m.id,
          ...medicationWindow(m),
          oneShot: m.oneShot,
          createdAt: m.createdAt,
        },
        // #1033: nothing is due on a medication with intake
        // tracking off.
        schedules: dueSchedules(m),
        now,
        userTz,
        lastIntakeAt: engineLastIntakeAt(m.id),
        resolvedSlots: resolvedSlotsByMedId.get(m.id) ?? [],
        eraStart: eraStartByMedId.get(m.id) ?? null,
      });
      return {
        name: m.name,
        dose: m.dose,
        nextDueAt: display ? display.at.toISOString() : null,
        overdue: display ? display.overdue : false,
        asNeeded: m.asNeeded,
        intakeTracked: m.trackIntake,
      };
    });

    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_medication_schedule", present: true },
    });
    return { present: true, medications: rows };
  },
};
