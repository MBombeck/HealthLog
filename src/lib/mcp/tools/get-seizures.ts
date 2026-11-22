import { z } from "zod/v4";

import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { fenceUserText } from "@/lib/ai/coach/data-fence";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { readSeizureDiary } from "@/lib/seizures/server";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

/** Default trailing window when the caller names none. */
const DEFAULT_SEIZURE_WINDOW_DAYS = 90;
/** Hard cap on the window. */
const MAX_SEIZURE_WINDOW_DAYS = 3 * 365;
/** Newest-first cap on the events one call returns. */
const MAX_SEIZURE_EVENTS = 200;

/**
 * Output schema for `get_seizures`. Every field beyond `present` is optional
 * so a `{ present: false }` miss and a full hit validate against one schema.
 */
const getSeizuresOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  windowDays: z.number().optional(),
  clusterRule: z
    .object({ count: z.number(), windowHours: z.number() })
    .optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
  types: z.array(z.record(z.string(), z.unknown())).optional(),
  events: z.array(z.record(z.string(), z.unknown())).optional(),
  truncated: z.boolean().optional(),
};

/**
 * `get_seizures` (#1368): the seizure diary over a bounded window.
 *
 * Read-only and module-gated: with the `seizures` module off the tool answers
 * `{ present: false, reason: "module_disabled" }`. Every figure is the
 * server's own derivation (the same one the diary page and the doctor report
 * use). The family's names for their seizure types, the rescue plan and every
 * note are the user's words and go out fenced in the USER_TEXT markers.
 */
export const getSeizuresTool: McpToolDefinition = {
  name: "get_seizures",
  title: "Get seizure diary",
  description:
    "Fetch the user's seizure diary over a bounded window (default: the last 90 days, at most three years): the person's own seizure types (their name for each, the ILAE 2025 type code, usual duration, the rescue plan text and medication), each recorded seizure (onset, duration and whether it was timed, how many seizures a tally stands for, confirmed or suspected, sleep state, rescue doses and their effect, injuries, suspected triggers, emergency care) and the server-derived summary (recorded seizures, seizure days, days since the last recorded seizure, cluster episodes under the record's own rule and under NICE's 3 in 24 hours, the type x month table). These are recorded seizures from a patient or carer diary and likely an undercount. Present them as the record, never as a diagnosis, a risk estimate, or advice to wait. Returns { present: false } when nothing is recorded or the seizure diary is switched off.",
  inputShape: {
    days: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEIZURE_WINDOW_DAYS)
      .optional()
      .describe(
        "Trailing window in days. Defaults to 90, capped at about three years.",
      ),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getSeizuresOutput,
  async run(ctx, args) {
    if (!(await isModuleEnabled(ctx.userId, "seizures"))) {
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_seizures", present: false, reason: "module" },
      });
      return { present: false, reason: "module_disabled" };
    }
    const days =
      typeof args.days === "number" ? args.days : DEFAULT_SEIZURE_WINDOW_DAYS;
    const now = new Date();
    const diary = await readSeizureDiary({
      userId: ctx.userId,
      viewerId: ctx.userId,
      tz: await resolveUserTimezone(ctx.userId),
      from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
      to: now,
      now,
    });

    if (diary.events.length === 0 && diary.types.length === 0) {
      annotate({
        action: { name: "mcp.tool.invoked" },
        meta: { tool: "get_seizures", present: false },
      });
      return { present: false, reason: "no_data" };
    }

    const fence = (v: string | null) => (v === null ? null : fenceUserText(v));
    const typeLabel = new Map(diary.types.map((t) => [t.id, t.label]));
    const events = diary.events.slice(0, MAX_SEIZURE_EVENTS).map((e) => ({
      id: e.id,
      onsetAt: e.onsetAt,
      onsetPrecision: e.onsetPrecision,
      type: e.typeProfileId
        ? fence(typeLabel.get(e.typeProfileId) ?? null)
        : null,
      ilaeType: e.effectiveIlaeType,
      durationSec: e.durationSec,
      durationSource: e.durationSource,
      count: e.count,
      certainty: e.certainty,
      sleepState: e.sleepState,
      responsiveness: e.responsiveness,
      recall: e.recall,
      postictalMinutes: e.postictalMinutes,
      postictal: e.postictal,
      injuries: e.injuries,
      triggersSuspected: e.triggers,
      emergency: e.emergency,
      witnessed: e.witnessed,
      loggedBy: e.loggedBy,
      overT1: e.flags.overT1,
      prolongedForThisPerson: e.flags.prolonged,
      rescueDoses: e.rescueDoses.map((d) => ({
        medication: fence(d.medicationName),
        doseAmount: d.doseAmount,
        doseUnit: d.doseUnit,
        route: d.route,
        givenAt: d.givenAt,
        effect: d.effect,
      })),
      note: fence(e.note),
      aura: fence(e.aura),
      semiology: e.semiology,
      semiologyNote: fence(e.semiologyNote),
      witnessNote: fence(e.witnessNote),
    }));
    const s = diary.summary;

    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_seizures", present: true, events: events.length },
    });
    return {
      present: true,
      windowDays: days,
      clusterRule: diary.settings.rule,
      summary: {
        // The figures count from here: the window's start, or the diary's
        // when it began later. No run is claimed before the diary existed.
        countedFrom: s.from,
        recordedSeizures: s.seizures,
        suspected: s.suspected,
        seizureDays: s.seizureDays,
        daysWithoutRecordedSeizure: s.seizureFreeDays,
        per28Days: s.per28Days,
        daysSinceLastRecorded: s.streak.daysSinceLast,
        longestRunWithoutRecordedSeizureDays: s.streak.longestFreeDays,
        bilateralTonicClonic: s.convulsive,
        fromSleep: s.fromSleep,
        clusterEpisodes: s.clusters.length,
        clusterEpisodesNice3In24h: s.niceClusterCount,
        rescueDoses: s.rescueDoses,
        emergencies: s.emergencies,
        monthly: s.monthly,
        note: "Recorded seizures from a patient or carer diary; likely an undercount, especially from sleep.",
      },
      types: diary.types.map((t) => ({
        id: t.id,
        name: fence(t.label),
        ilaeType: t.ilaeType,
        usualDurationSec: t.usualDurationSec,
        rescuePlan: fence(t.rescuePlan),
        rescueMedication: fence(t.rescueMedicationName),
        archived: t.archived,
      })),
      events,
      truncated: diary.truncated || diary.events.length > events.length,
    };
  },
};
