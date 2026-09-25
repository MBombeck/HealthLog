/**
 * v1.15.18 — traceable dose-history read endpoint (spec B; audit deliverable).
 *
 *   GET /api/medications/[id]/dose-history?from=&to=
 *     → the full per-slot ledger for the medication over [from, to]: every
 *       expected slot with a status (taken on-time / taken late / skipped /
 *       missed / upcoming) plus every off-schedule intake tagged ad-hoc.
 *
 * This is the read-model the medication "Verlauf" tab renders. It is built
 * from the SAME shared band minter + `reconstructDoseHistory` that the
 * compliance % and the write/edit attribution consume, so the history view and
 * the rate can never contradict each other. Additive (a new GET) → iOS-safe.
 *
 * Ownership-scoped via `assertMedicationOwnership`; rate-limited; reads only
 * `deletedAt: null` rows.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { lastNonSkippedTakenAt } from "@/lib/analytics/compliance";
import type { SlotBand } from "@/lib/medications/scheduling/attribution";
import {
  type BandFamily,
  type BandMinterMedication,
} from "@/lib/medications/scheduling/band-minter";
import { buildBandsForSchedulesWithEras } from "@/lib/medications/scheduling/schedule-eras";
import {
  reconstructDoseHistory,
  type DoseHistoryRow,
  type HistoryIntake,
} from "@/lib/medications/scheduling/dose-history";
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  type WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";

type RouteParams = { params: Promise<{ id: string }> };

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_DAYS = 366;

// Match the glp1 POST / bulk-delete cap so a caller can't pin the per-request
// band expansion. 60/min/user is generous for a hand-driven history view.
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

const querySchema = z
  .object({
    from: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional(),
    to: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional(),
  })
  .refine((q) => !q.from || !q.to || q.to.getTime() >= q.from.getTime(), {
    message: "`to` must be on or after `from`",
    path: ["to"],
  });

/** The serialised shape the Verlauf tab consumes (instants as ISO strings). */
interface SerializedDoseHistoryRow {
  kind: "slot" | "ad_hoc";
  at: string;
  timeOfDay: string | null;
  status: DoseHistoryRow["status"];
  /** v1.15.20 — slot served by a deliberate user pin ("zugeordnet"). */
  pinned?: boolean;
  /** v1.15.20 — due-context for an ad-hoc take: the nearest slot it could
   * belong to (preferring an unserved one), so the UI can show "fällig
   * gewesen" and offer the pin when `filled` is false. */
  nearestSlot?: { at: string; timeOfDay: string; filled: boolean };
  intake: {
    id: string | null;
    scheduledFor: string;
    takenAt: string | null;
    skipped: boolean;
    autoMissed: boolean;
    /** v1.16.4 — per-intake dose override; null = configured dose. */
    doseTaken: string | null;
    /** v1.32.8 (iOS #64) — how the dose was recorded; null on legacy rows. */
    source: "WEB" | "API" | "REMINDER" | "IMPORT" | "APPLE_HEALTH" | null;
  } | null;
}

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const rl = await checkRateLimit(
      `medication-dose-history:${user.id}`,
      RATE_LIMIT,
      RATE_WINDOW_MS,
    );
    if (!rl.allowed) {
      return apiError("Too many requests", 429, {
        headers: rateLimitHeaders(rl),
      });
    }

    const parsed = querySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422);
    }

    const now = new Date();
    const userTz = user.timezone || "Europe/Berlin";

    const medication = await prisma.medication.findUnique({
      where: { id },
      include: {
        schedules: true,
        // v1.16.3 — archived schedule eras: past days mint against the
        // schedule that was live THEN.
        scheduleRevisions: { orderBy: { validFrom: "asc" } },
      },
    });
    if (!medication) {
      return apiError("Medication not found", 404);
    }

    // Resolve the window. Default to the trailing 90 days and cap the span
    // so a pathological `from=1970` can't expand a year-plus of bands. `to`
    // defaults to `now`.
    const to = parsed.data.to ?? now;
    const requestedFrom =
      parsed.data.from ?? new Date(to.getTime() - 90 * DAY_MS);
    const spanFloor = new Date(to.getTime() - MAX_WINDOW_DAYS * DAY_MS);
    // The window the caller asked for, capped only by the span limit. Both
    // recorded doses and minted slots use it: a dose logged for a slot
    // before the medication was added (created at 16:20, the 14:00 dose
    // recorded afterwards) is a real record and must meet its slot, or it
    // reads as an off-schedule take due at the next slot (#1028). Slots
    // before the creation that no recorded dose claims stay out of the
    // ledger: `reconstructDoseHistory` receives the creation instant as the
    // floor of expected slots, so pre-existence days never read as missed.
    const from = new Date(
      Math.max(requestedFrom.getTime(), spanFloor.getTime()),
    );

    const events = await prisma.medicationIntakeEvent.findMany({
      where: { medicationId: id, userId: user.id, deletedAt: null },
      orderBy: { scheduledFor: "desc" },
      select: {
        id: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
        autoMissed: true,
        // v1.15.20 — USER_PIN rows bind by anchor in the read ledger.
        attributionSource: true,
        // v1.16.4 — per-intake dose override for the ledger's deviation hint.
        doseTaken: true,
        // v1.32.8 (iOS #64) — write provenance so the client can label how
        // each dose was recorded (Web / API / Reminder / Import / AppleHealth).
        source: true,
      },
    });

    const mapped = events.map((e) => ({
      id: e.id,
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed,
      pinned: e.attributionSource === "USER_PIN",
      doseTaken: e.doseTaken,
      source: e.source,
    }));

    const lastIntakeAt = lastNonSkippedTakenAt(mapped);

    // A dose may be recorded before its slot's own time: the dose window opens
    // up to two hours early, and a skip can be logged ahead. Such a row is
    // stored on the slot's anchor, which still lies after `to`, so a window
    // that ends at `to` dropped a dose the user had just recorded until the
    // slot's clock time passed (#1028). Extend the read horizon to the latest
    // anchor of a recorded row (taken or skipped) within a day of `to`, and no
    // further: pending reminder rows record nothing and never stretch it.
    const horizon = new Date(
      mapped.reduce((latest, e) => {
        const t = e.scheduledFor.getTime();
        const recorded = e.skipped || (e.takenAt !== null && e.takenAt <= to);
        return recorded && t > latest && t <= to.getTime() + DAY_MS
          ? t
          : latest;
      }, to.getTime()),
    );

    const bandMedication: BandMinterMedication = {
      id: medication.id,
      startsOn: medication.startsOn,
      endsOn: medication.endsOn,
      oneShot: medication.oneShot,
      createdAt: medication.createdAt,
    };
    const ctx = buildRecurrenceContext({
      medication: bandMedication,
      userTz,
      lastIntakeAt,
    });
    // A legacy daily schedule carrying only `windowStart` surfaces it as the
    // single time-of-day so the minter mints its daily band (mirrors the
    // compliance route + the ledger tally).
    const canonicalSchedules = medication.schedules.map((s) => {
      const canonical = buildCanonicalSchedule(s as WorkerScheduleRow);
      if (
        canonical.timesOfDay.length === 0 &&
        canonical.rrule === null &&
        canonical.rollingIntervalDays === null &&
        canonical.scheduleType !== "PRN" &&
        !medication.oneShot
      ) {
        return { ...canonical, timesOfDay: [canonical.windowStart] };
      }
      return canonical;
    });

    // Rolling cadences anchor their retrospective grid AT each logged intake.
    const intakeInstants = mapped
      .filter((e) => !e.skipped && e.takenAt !== null && e.takenAt <= to)
      .map((e) => e.takenAt as Date)
      .sort((a, b) => a.getTime() - b.getTime());

    const groups = buildBandsForSchedulesWithEras({
      medication: bandMedication,
      schedules: canonicalSchedules,
      revisions: medication.scheduleRevisions ?? [],
      ctx,
      userTz,
      range: { from, to: horizon },
      now,
      intakeInstants,
    });
    const bands: SlotBand[] = [];
    let family: BandFamily = "none";
    for (const g of groups) {
      if (g.hasExpectedSlots) {
        bands.push(...g.bands);
        if (family === "none") family = g.family;
      }
    }

    // Intakes whose slot anchor falls in the window. An ad-hoc take buckets on
    // its real time, but the ledger reads `scheduledFor` for the membership
    // partition, so filter on the stored anchor (a take snapped to an
    // out-of-window slot is excluded, matching the compliance read).
    const historyIntakes: HistoryIntake[] = mapped
      .filter((e) => e.scheduledFor >= from && e.scheduledFor <= horizon)
      .map((e) => ({
        id: e.id,
        scheduledFor: e.scheduledFor,
        takenAt: e.takenAt,
        skipped: e.skipped,
        autoMissed: e.autoMissed,
        pinned: e.pinned,
        doseTaken: e.doseTaken,
        source: e.source,
      }));

    const rows = reconstructDoseHistory(
      bands,
      historyIntakes,
      now,
      medication.createdAt,
    );

    const serialized: SerializedDoseHistoryRow[] = rows.map((row) => ({
      kind: row.kind,
      at: row.at.toISOString(),
      timeOfDay: row.timeOfDay,
      status: row.status,
      ...(row.pinned && { pinned: true }),
      ...(row.nearestSlot && {
        nearestSlot: {
          at: row.nearestSlot.at.toISOString(),
          timeOfDay: row.nearestSlot.timeOfDay,
          filled: row.nearestSlot.filled,
        },
      }),
      intake: row.intake
        ? {
            id: row.intake.id ?? null,
            scheduledFor: row.intake.scheduledFor.toISOString(),
            takenAt: row.intake.takenAt?.toISOString() ?? null,
            skipped: row.intake.skipped,
            autoMissed: row.intake.autoMissed ?? false,
            doseTaken: row.intake.doseTaken ?? null,
            source: row.intake.source ?? null,
          }
        : null,
    }));

    annotate({
      action: {
        name: "medication.dose_history",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { row_count: serialized.length, family },
    });

    // The window the recorded doses were read over (#1028): from the
    // requested start to the read horizon, which reaches past `to` only for
    // a dose recorded ahead of its slot.
    return apiSuccess({
      from: from.toISOString(),
      to: horizon.toISOString(),
      family,
      hasExpectedSlots: bands.length > 0,
      rows: serialized,
    });
  },
);
