/**
 * v1.16.11 — medication low-stock notifications (one engine, every
 * tracked medication).
 *
 * Generalises the GLP-1-only low-stock surface (the fixed 4-dose
 * `lowStock` flag the GLP-1 details endpoint computes for its card)
 * into one daily pass over EVERY medication with tracked inventory.
 * The GLP-1 case needs nothing special here: its weekly schedule flows
 * through the same runway math as any other cadence — the card flag
 * stays as the locked iOS read-model, the notification is this engine.
 *
 * Trigger: a medication qualifies when it has tracked inventory (at
 * least one container ever registered — the list payload's
 * `stockUnitsRemaining` non-null predicate) AND its projected runway
 * in days falls strictly below the user's threshold. Runway reuses the
 * shared math verbatim:
 *   - available units: `summariseSupply` (ACTIVE / IN_USE with units
 *     left; EXPIRED visible but never available),
 *   - daily consumption: `estimateDailyDoseCount` over the schedules
 *     (the detail Übersicht's `estimateRunwayDays` source),
 * so the push can never disagree with the detail page's "lasts about
 * N more days" line. A medication whose schedules derive no daily
 * consumption (none, or zero times) has NO runway and never notifies.
 *
 * Threshold: per-user `notificationPrefs.medication.lowStockRunwayDays`
 * (1–60 days, default 7, `null` = off) — surfaced on
 * `GET /api/settings/reminder-thresholds`, written through
 * `PATCH /api/auth/me/notification-prefs`.
 *
 * v1.17.0 — reorder lead time. The bare runway floor fired a sparse
 * cadence (e.g. a weekly injection) only when ~1 dose was left — too
 * late to reorder. The effective trigger widens the floor to
 * `max(lowStockRunwayDays, leadDays + cadenceIntervalDays)` so the
 * warning lands BEFORE the last dose for any cadence. `leadDays` is the
 * per-medication `Medication.reorderLeadDays` override, else the
 * user-level `notificationPrefs.medication.reorderLeadDays` default
 * (0–60, default 10). Because the trigger is a `max(...)` over the
 * user's floor it never shrinks anyone's current threshold.
 *
 * Anti-spam: notify ONCE per threshold crossing. The stamp lives on
 * the medication row (`lowStockNotifiedAt` +
 * `lowStockNotifiedThresholdDays`); the pass clears it (re-arms) when
 * the runway rises back to / above the threshold (refill), and a
 * stamped threshold that differs from the current one counts as
 * re-armed so a threshold change is heard. A dispatch that reaches no
 * channel leaves the stamp clear, so tomorrow's tick retries.
 *
 * clientManaged is deliberately NOT consulted: that suppression
 * contract covers reminders a client can schedule locally
 * (MEDICATION_REMINDER dose slots, cycle predictions). Inventory state
 * is server-side only — no client can derive it — so this event
 * follows the COACH_NUDGE posture (server-only, prefs-gated).
 *
 * Inactive / paused medications are skipped: nothing consumes their
 * stock, so their runway is not falling.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  classifyLowStockState,
  effectiveUnitsPerDose,
  estimateDailyDoseCount,
  estimateRunwayDays,
  lowStockTriggerDays,
  supplyRunwayDates,
  type RunwaySchedule,
} from "@/components/medications/detail/supply-runway";
import {
  detectSupplyUnderflow,
  summariseSupply,
  type SupplyItem,
} from "@/lib/medications/inventory/summary";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import {
  resolveLowStockRunwayDays,
  resolveReorderLeadDays,
} from "@/lib/validations/notification-prefs";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { coerceLocale, type Locale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { annotate, getEvent } from "@/lib/logging/context";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";

/** Pg-boss queue + cron — imported by the reminder worker's bootstrap. */
export const MEDICATION_LOW_STOCK_QUEUE = "medication-low-stock";
/**
 * 09:00 Europe/Berlin — a supply alert is an errand prompt ("order a
 * refill"), not a night signal; it fires once daily at a time the user
 * can act on it.
 */
export const MEDICATION_LOW_STOCK_CRON = "0 9 * * *";

export interface MedicationLowStockSummary {
  usersScanned: number;
  skippedThresholdOff: number;
  medicationsEvaluated: number;
  notified: number;
  rearmed: number;
  skippedAlreadyNotified: number;
  skippedAboveThreshold: number;
  skippedNoRunway: number;
  skippedNoChannel: number;
  failed: number;
}

export interface LowStockEvaluation {
  /** Whole days the available supply covers; null = no runway derivable. */
  runwayDays: number | null;
  dosesRemaining: number;
  unitsRemaining: number;
  /**
   * Units sitting in containers that were declared unusable. Never part
   * of the runway — but "you have nothing left" and "everything you have
   * left is written off" are different errands, so the push has to be
   * able to tell them apart.
   */
  expiredUnits: number;
}

/**
 * Shared runway evaluation: `summariseSupply` availability semantics ÷
 * `estimateDailyDoseCount` consumption. Exported for the unit tests.
 * Zero available doses with a consuming schedule is runway 0 (below
 * every threshold); no consuming schedule is `null` (never notifies).
 */
export function evaluateMedicationRunway(
  items: readonly SupplyItem[],
  unitsPerDose: number,
  schedules: RunwaySchedule[],
): LowStockEvaluation {
  // v1.37.19 — divide the pool by the schedule-weighted average units per
  // dose, so a per-slot medication's doses/runway match the wire figures.
  const supply = summariseSupply(
    items,
    effectiveUnitsPerDose(schedules, unitsPerDose),
  );
  // v1.18.11 (#31) — server-side observability for the central stock clamp.
  // `summariseSupply` floors a corrupt/legacy negative pool to zero; this is
  // the request-scoped seam that records the underflow so the data defect
  // stays visible if it ever recurs.
  const underflow = detectSupplyUnderflow(items);
  if (underflow) {
    annotate({
      action: { name: "medication.inventory.underflow" },
      meta: {
        raw_units_remaining: underflow.rawUnitsRemaining,
        raw_units_total: underflow.rawUnitsTotal,
        clamped_units_remaining: underflow.clampedUnitsRemaining,
        available_count: underflow.availableCount,
      },
    });
  }
  const perDay = estimateDailyDoseCount(schedules);
  if (perDay <= 0) {
    return {
      runwayDays: null,
      dosesRemaining: supply.dosesRemaining,
      unitsRemaining: supply.unitsRemaining,
      expiredUnits: supply.expiredUnits,
    };
  }
  const runwayDays =
    supply.dosesRemaining > 0
      ? (estimateRunwayDays(supply.dosesRemaining, schedules) ?? 0)
      : 0;
  return {
    runwayDays,
    dosesRemaining: supply.dosesRemaining,
    unitsRemaining: supply.unitsRemaining,
    expiredUnits: supply.expiredUnits,
  };
}

export type LowStockDecision =
  | "notify"
  | "rearm"
  | "skip_above_threshold"
  | "skip_already_notified"
  | "skip_no_runway";

/**
 * Pure crossing logic — exported for the unit tests so the boundary /
 * dedupe / re-arm semantics stay pinned without a DB.
 *
 * v1.17.0 — the comparison is against the EFFECTIVE trigger
 * (`triggerDays`), which the caller derives via `lowStockTriggerDays`
 * from the user's `lowStockRunwayDays` floor, the reorder lead time, and
 * the cadence interval. The boundary is now `runway ≤ triggerDays` (was
 * strictly-below the bare floor): a weekly cadence whose runway equals
 * one dose-interval still fires with reorder headroom.
 *
 * Every cadence WIDENS by the lead (the default lead is 10, so a daily
 * med's trigger becomes max(7, 10 + 1) = 11 and it now alerts ~4 days
 * earlier than the pre-v1.17.0 `< 7`). The boundary only ever moves the
 * alert EARLIER, never later — `triggerDays` is `max(floor, …)`, so it
 * can never drop below the user's floor and no one's current threshold
 * shrinks. A daily med keeps the old `< 7` boundary ONLY at lead 0
 * (trigger stays 7); the "unchanged daily" case in the tests pins that
 * lead-0 corner, not the default.
 *
 *   runway ≤ trigger  → notify, unless the stamp already records THIS
 *                       trigger's crossing (`skip_already_notified`).
 *                       A stamp written against a DIFFERENT trigger
 *                       counts as re-armed and notifies again.
 *   runway > trigger  → re-arm (clear the stamp) when one is set;
 *                       otherwise nothing to do.
 *   runway null       → no runway derivable (schedule-less) — never
 *                       notifies, stamp untouched.
 *
 * The re-arm stamp records `triggerDays`, not the bare floor, so a
 * change to EITHER the user threshold or the reorder lead re-arms the
 * medication and the user hears the next crossing.
 */
export function decideLowStockAction(input: {
  runwayDays: number | null;
  triggerDays: number;
  notifiedAt: Date | null;
  notifiedThresholdDays: number | null;
}): LowStockDecision {
  if (input.runwayDays === null) return "skip_no_runway";
  if (input.runwayDays > input.triggerDays) {
    return input.notifiedAt !== null ? "rearm" : "skip_above_threshold";
  }
  if (
    input.notifiedAt !== null &&
    input.notifiedThresholdDays === input.triggerDays
  ) {
    return "skip_already_notified";
  }
  return "notify";
}

/**
 * v1.17.0 — localised push copy. When the supply data is rich enough to
 * date (`runwayDays >= 1` with a derivable cadence) the body names the
 * two concrete dates — "Supply runs out ~<date> — reorder by <date>" —
 * so the user can act without doing the arithmetic. The `last_dose`
 * state gets its own calmer line (the final dose is imminent; the
 * reorder-by date has already passed). Runway 0 keeps the depleted line;
 * a thin / undatable supply keeps the days/units fallback so the push
 * never reads broken.
 */
export function buildLowStockPayload(input: {
  locale: string | null | undefined;
  medName: string;
  runwayDays: number;
  unitsRemaining: number;
  expiredUnits: number;
  leadDays: number;
  triggerDays: number;
  schedules: RunwaySchedule[];
  today: Date;
}): { title: string; body: string } {
  const t = getServerTranslator(coerceLocale(input.locale)).t;
  const title = t("lowStockReminders.title", { medName: input.medName });

  if (input.runwayDays < 1) {
    // Nothing usable left. Whether that means the packs are empty or
    // that every remaining unit was written off is the difference
    // between "reorder" and "check whether that really is unusable", so
    // the two get different copy.
    if (input.unitsRemaining <= 0 && input.expiredUnits > 0) {
      return {
        title,
        body: t("lowStockReminders.bodyExpired", {
          medName: input.medName,
          units: input.expiredUnits,
        }),
      };
    }
    return {
      title,
      body: t("lowStockReminders.bodyToday", {
        medName: input.medName,
        units: input.unitsRemaining,
      }),
    };
  }

  const state = classifyLowStockState({
    runwayDays: input.runwayDays,
    triggerDays: input.triggerDays,
    schedules: input.schedules,
  });
  const { runsOutOn, reorderBy } = supplyRunwayDates({
    today: input.today,
    runwayDays: input.runwayDays,
    leadDays: input.leadDays,
  });
  // Day-only, UTC: the runway dates are UTC-midnight calendar days, so a
  // UTC formatter renders the intended day in every locale. A medium
  // style stays compact and unambiguous for a push body.
  const dateFmt = new Intl.DateTimeFormat(coerceLocale(input.locale), {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const fmt = (d: Date) => dateFmt.format(d);

  if (state === "last_dose") {
    // Final dose imminent — informational. No "reorder by" date: the
    // lead window has lapsed, so the line names only the run-out date.
    return {
      title,
      body: t("lowStockReminders.bodyLastDose", {
        medName: input.medName,
        units: input.unitsRemaining,
        runsOutOn: fmt(runsOutOn),
      }),
    };
  }

  return {
    title,
    body: t("lowStockReminders.bodyReorder", {
      medName: input.medName,
      units: input.unitsRemaining,
      runsOutOn: fmt(runsOutOn),
      reorderBy: fmt(reorderBy),
    }),
  };
}

/** Pinned wide-event meta shape for `.notified` / `.skipped` entries. */
interface LowStockEventMeta {
  user_id: string;
  medication_id: string;
  runway_days: number | null;
  threshold_days: number;
  doses_remaining: number;
  units_remaining: number;
  expired_units: number;
  reason?: "already_notified" | "no_runway" | "no_channel";
}

/**
 * Run one medication-low-stock cron tick. Per-user work is wrapped in
 * its own try/catch so a single bad row cannot abort the rest of the
 * pass (the coach-nudge posture).
 */
export async function runMedicationLowStockTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
  } = {},
): Promise<MedicationLowStockSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;

  const summary: MedicationLowStockSummary = {
    usersScanned: 0,
    skippedThresholdOff: 0,
    medicationsEvaluated: 0,
    notified: 0,
    rearmed: 0,
    skippedAlreadyNotified: 0,
    skippedAboveThreshold: 0,
    skippedNoRunway: 0,
    skippedNoChannel: 0,
    failed: 0,
  };

  const notifiedMeta: LowStockEventMeta[] = [];
  const skippedMeta: LowStockEventMeta[] = [];

  // Only users who own at least one ACTIVE, unpaused medication with
  // tracked inventory (any container ever registered) are candidates.
  const users = await prisma.user.findMany({
    where: {
      medications: {
        some: {
          active: true,
          pausedAt: null,
          // v1.39.1 (#1033) — no low-stock notice for a medication with
          // intake tracking off: no dose consumes its stock.
          ...TRACKED_INTAKE_WHERE,
          inventoryItems: { some: {} },
        },
      },
    },
    select: { id: true, locale: true, notificationPrefs: true },
  });

  for (const user of users) {
    summary.usersScanned += 1;
    try {
      // Gate — per-user threshold. `null` = the alert is off; the
      // stamps stay as-is and the threshold-change rule re-arms them
      // if the user later re-enables with a different value.
      const thresholdDays = resolveLowStockRunwayDays(user.notificationPrefs);
      if (thresholdDays === null) {
        summary.skippedThresholdOff += 1;
        continue;
      }

      const medications = await prisma.medication.findMany({
        where: {
          userId: user.id,
          active: true,
          pausedAt: null,
          ...TRACKED_INTAKE_WHERE,
          inventoryItems: { some: {} },
        },
        select: {
          id: true,
          name: true,
          unitsPerDose: true,
          // v1.17.0 — per-medication reorder lead override (null =
          // inherit the user-level default).
          reorderLeadDays: true,
          lowStockNotifiedAt: true,
          lowStockNotifiedThresholdDays: true,
          inventoryItems: {
            select: { state: true, unitsTotal: true, unitsRemaining: true },
          },
          schedules: {
            select: {
              windowStart: true,
              daysOfWeek: true,
              timesOfDay: true,
              rrule: true,
              rollingIntervalDays: true,
              // v1.37.19 — per-slot units feed the slot-aware burn rate.
              unitsPerDose: true,
            },
          },
        },
      });

      for (const med of medications) {
        summary.medicationsEvaluated += 1;

        // Decimal → number for the per-slot units so the runway math and
        // the wire's `runwayDays` read the identical shape.
        const runwaySchedules: RunwaySchedule[] = med.schedules.map(
          (sched) => ({
            ...sched,
            unitsPerDose:
              sched.unitsPerDose === null ? null : Number(sched.unitsPerDose),
          }),
        );

        const evaluation = evaluateMedicationRunway(
          // v1.16.12 — Decimal columns → JS numbers for the runway math.
          med.inventoryItems.map((it) => ({
            state: it.state,
            unitsTotal: Number(it.unitsTotal),
            unitsRemaining: Number(it.unitsRemaining),
          })),
          Number(med.unitsPerDose),
          runwaySchedules,
        );

        // v1.17.0 — effective reorder lead (per-med override beats the
        // user default) widens the bare runway floor by lead + one
        // dose-interval so the alert lands before the last dose. The
        // trigger never shrinks below the user's `lowStockRunwayDays`.
        const leadDays = resolveReorderLeadDays(
          user.notificationPrefs,
          med.reorderLeadDays,
        );
        const triggerDays = lowStockTriggerDays({
          lowStockRunwayDays: thresholdDays,
          leadDays,
          schedules: runwaySchedules,
        });

        const decision = decideLowStockAction({
          runwayDays: evaluation.runwayDays,
          triggerDays,
          notifiedAt: med.lowStockNotifiedAt,
          notifiedThresholdDays: med.lowStockNotifiedThresholdDays,
        });

        const meta: LowStockEventMeta = {
          user_id: user.id,
          medication_id: med.id,
          runway_days: evaluation.runwayDays,
          // The effective trigger (post lead + cadence widening), so the
          // wide event reflects the threshold the crossing fired against.
          threshold_days: triggerDays,
          doses_remaining: evaluation.dosesRemaining,
          units_remaining: evaluation.unitsRemaining,
          expired_units: evaluation.expiredUnits,
        };

        switch (decision) {
          case "skip_no_runway":
            summary.skippedNoRunway += 1;
            skippedMeta.push({ ...meta, reason: "no_runway" });
            break;
          case "skip_above_threshold":
            summary.skippedAboveThreshold += 1;
            break;
          case "skip_already_notified":
            summary.skippedAlreadyNotified += 1;
            skippedMeta.push({ ...meta, reason: "already_notified" });
            break;
          case "rearm":
            await prisma.medication.update({
              where: { id: med.id },
              data: {
                lowStockNotifiedAt: null,
                lowStockNotifiedThresholdDays: null,
              },
            });
            summary.rearmed += 1;
            break;
          case "notify": {
            const { title, body } = buildLowStockPayload({
              locale: await resolveJobLocale(user.locale),
              medName: med.name,
              runwayDays: evaluation.runwayDays ?? 0,
              unitsRemaining: evaluation.unitsRemaining,
              expiredUnits: evaluation.expiredUnits,
              leadDays,
              triggerDays,
              schedules: runwaySchedules,
              today: now,
            });
            const renderForRecipient = (locale: Locale) => {
              const rendered = buildLowStockPayload({
                locale,
                medName: med.name,
                runwayDays: evaluation.runwayDays ?? 0,
                unitsRemaining: evaluation.unitsRemaining,
                expiredUnits: evaluation.expiredUnits,
                leadDays,
                triggerDays,
                schedules: runwaySchedules,
                today: now,
              });
              return { title: rendered.title, message: rendered.body };
            };
            const outcome = await dispatchImpl({
              eventType: "MEDICATION_LOW_STOCK",
              userId: user.id,
              title,
              message: body,
              renderForRecipient,
              metadata: {
                scheduledAt: now.toISOString(),
                medicationId: med.id,
                runwayDays: evaluation.runwayDays,
                thresholdDays,
                // v1.17.0 — the effective trigger + reorder lead so the
                // client can render the same dates the push body names.
                triggerDays,
                leadDays,
                unitsRemaining: evaluation.unitsRemaining,
                dosesRemaining: evaluation.dosesRemaining,
                // Stock the user physically holds but that was declared
                // unusable. The client shows it so "0 left" never reads
                // as "you never had any".
                expiredUnits: evaluation.expiredUnits,
                // Deep link — the web-push sender threads this into
                // the service-worker payload's click target. Lands on
                // the detail page's Bestand (supply) tab, the surface
                // the alert is about.
                url: `/medications/${med.id}?tab=bestand`,
              },
            });
            if (!outcome.dispatched) {
              // No channel succeeded — leave the stamp clear so the
              // next daily tick retries the crossing.
              summary.skippedNoChannel += 1;
              skippedMeta.push({ ...meta, reason: "no_channel" });
              break;
            }
            await prisma.medication.update({
              where: { id: med.id },
              data: {
                lowStockNotifiedAt: now,
                // v1.17.0 — stamp the EFFECTIVE trigger so a later change
                // to the user threshold OR the reorder lead re-arms the
                // medication (the decision compares against this value).
                lowStockNotifiedThresholdDays: triggerDays,
              },
            });
            summary.notified += 1;
            notifiedMeta.push(meta);
            break;
          }
        }
      }
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `medication-low-stock per-user pass failed for ${user.id}: ${message}`,
      );
    }
  }

  // Wide events — pinned meta shape (see `LowStockEventMeta`), one
  // entry per medication, emitted once per tick.
  if (notifiedMeta.length > 0) {
    annotate({
      meta: { "medication.inventory.low_stock.notified": notifiedMeta },
    });
  }
  if (skippedMeta.length > 0) {
    annotate({
      meta: { "medication.inventory.low_stock.skipped": skippedMeta },
    });
  }

  return summary;
}
