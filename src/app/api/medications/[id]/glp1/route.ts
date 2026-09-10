/**
 * v1.4.25 W4d — GLP-1 medication details endpoint.
 *
 * Returns per-medication extras the GLP-1 card variant + the dashboard
 * tile + the doctor-report PDF section read: chronological dose-change
 * history, the last 12 injection events (with optional site
 * rotation data), and the running pen-inventory math. The base
 * /api/medications/[id] GET is unchanged so v1.4.24 consumers keep
 * working untouched.
 *
 * v1.4.25 W21 Fix-K — POST hardened with Zod parse, audit-log, 30/min
 * rate-limit, finite-number guard on `doseValue`, length cap on `note`,
 * and sane bounds on `effectiveFrom`. Mirrors the sibling
 * `/inventory` + `/side-effects` route shape.
 */

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { glp1PostBodySchema } from "@/lib/validations/medication";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { withIdempotency } from "@/lib/idempotency";
import {
  estimateDailyDoseCount,
  estimateRunwayDays,
  lowStockTriggerDays,
  type RunwaySchedule,
} from "@/components/medications/detail/supply-runway";
import {
  resolveLowStockRunwayDays,
  resolveReorderLeadDays,
} from "@/lib/validations/notification-prefs";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  encryptNote,
  readNote,
  shapeDoseChangeNote,
} from "@/lib/crypto/note-cipher";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

const POST_RATE_LIMIT = 30;
const POST_WINDOW_MS = 60_000;

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    // The read resolves the RECORD, at the level its siblings use. It did not
    // until the route was published, and the asymmetry that produced is the
    // reason it is written down here: the POST below has resolved the record
    // since v1.37.0, so a manager could add a titration step to a medication
    // whose history the GET refused them — may write, may not read, which is
    // not a shape any reading of the sharing model produces. `read` rather
    // than the POST's `manage` because that is what `/inventory`,
    // `/side-effects` and `/cadence` ask for the same medication's data, and
    // this read is strictly narrower than the write already permitted.
    const { user } = await requireRecordAuth("read", "medications");
    const { id } = await params;

    // v1.5.5 F-1 C-4 — close the §10 invariant 24 gap. The destructive
    // sweep in af224964 lifted every sibling `[id]/**` handler onto the
    // shared ownership helper; the glp1 GET still hand-rolled the
    // `findUnique + userId compare` pattern. Routing it through the
    // same predicate keeps the 404 leak shape identical across every
    // handler in the directory.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const medication = await prisma.medication.findUnique({
      where: { id },
      include: {
        doseChanges: { orderBy: { effectiveFrom: "asc" } },
        // v1.16.10 — the inventory block reads the per-item entities
        // (the same rows the Bestand tab and the intake consumption
        // hook move). The legacy MedicationInventoryEvent running-sum
        // ledger stays as a READ fallback for accounts that only ever
        // posted deltas: when zero items exist, the ledger-derived
        // numbers surface instead of a silent null.
        inventoryItems: { orderBy: { createdAt: "asc" } },
        inventoryEvents: { orderBy: { occurredAt: "asc" } },
        intakeEvents: {
          where: { takenAt: { not: null } },
          orderBy: { takenAt: "desc" },
          take: 12,
          select: { takenAt: true, injectionSite: true },
        },
        schedules: true,
      },
    });

    if (!medication) {
      return apiError("Medication not found", 404);
    }

    // v1.17.0 — the card `lowStock` flag rides the SAME reorder-lead-aware
    // runway evaluation as the daily low-stock cron, so the GLP-1 card and
    // the notification can never disagree. The legacy fixed 4-dose count
    // threshold (`LOW_STOCK_DOSE_THRESHOLD`) is retired: a weekly cadence's
    // "4 doses" was ~28 days — far too eager — while a daily med at 4 doses
    // was ~4 days — far too late. Runway days ≤ the effective trigger
    // (`max(lowStockRunwayDays, leadDays + cadenceIntervalDays)`) is the one
    // truth. `lowStockRunwayDays === null` (alert off) ⇒ flag never lights.
    const prefsRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { notificationPrefs: true },
    });
    const runwayFloor = resolveLowStockRunwayDays(
      prefsRow?.notificationPrefs ?? null,
    );
    const leadDays = resolveReorderLeadDays(
      prefsRow?.notificationPrefs ?? null,
      medication.reorderLeadDays,
    );
    const schedules: RunwaySchedule[] = medication.schedules.map((sched) => ({
      ...sched,
      // Decimal → number so the slot-aware runway math reads the wire shape.
      unitsPerDose:
        sched.unitsPerDose === null ? null : Number(sched.unitsPerDose),
    }));
    /** runway ≤ effective trigger AND the alert is enabled. */
    const isLowStock = (dosesRemaining: number): boolean => {
      if (runwayFloor === null) return false;
      // No consuming schedule ⇒ no runway ⇒ never low (matches the cron's
      // `evaluateMedicationRunway` null branch).
      if (estimateDailyDoseCount(schedules) <= 0) return false;
      const triggerDays = lowStockTriggerDays({
        lowStockRunwayDays: runwayFloor,
        leadDays,
        schedules,
      });
      // Exhausted supply with a consuming schedule is runway 0 (below
      // every trigger); otherwise the cadence-aware days of supply. Same
      // semantics the cron's `evaluateMedicationRunway` applies.
      const runwayDays =
        dosesRemaining > 0
          ? (estimateRunwayDays(dosesRemaining, schedules) ?? 0)
          : 0;
      return runwayDays <= triggerDays;
    };

    // Inventory math over the per-item entities. The response shape is
    // locked for the iOS client: `pensRemaining` = count of usable
    // containers (ACTIVE / IN_USE with units left), `dosesRemaining` =
    // pooled units divided by `unitsPerDose` (floored — consumption
    // spills across containers), `weeksOfSupply` keeps the weekly-
    // cadence approximation (the canonical GLP-1 case).
    let inventory: {
      pensRemaining: number | null;
      dosesRemaining: number | null;
      weeksOfSupply: number | null;
      lowStock: boolean;
    } | null = null;
    if (medication.inventoryItems.length > 0) {
      const usable = medication.inventoryItems.filter(
        (item) =>
          (item.state === "ACTIVE" || item.state === "IN_USE") &&
          Number(item.unitsRemaining) > 0,
      );
      const unitsRemaining = usable.reduce(
        (sum, item) => sum + Number(item.unitsRemaining),
        0,
      );
      const pensRemaining = usable.length;
      const dosesRemaining = Math.floor(
        unitsRemaining / (Number(medication.unitsPerDose) || 1),
      );
      const weeksOfSupply = dosesRemaining;
      const lowStock = isLowStock(dosesRemaining);
      inventory = {
        pensRemaining,
        dosesRemaining,
        weeksOfSupply,
        lowStock,
      };
    } else if (
      medication.dosesPerUnit &&
      medication.inventoryEvents.length > 0
    ) {
      // Read-side fallback for ledger-only accounts (pre-v1.16.10 the
      // POST below was the only inventory writer). Items win whenever
      // any exist — the ledger never overrides them and no item rows
      // are fabricated from it. Math is the pre-item contract verbatim:
      // running sum of deltas counts pens, `dosesPerUnit` maps pens to
      // doses, weekly cadence approximates the supply horizon.
      const pens = medication.inventoryEvents.reduce(
        (sum, ev) => sum + ev.delta,
        0,
      );
      const pensRemaining = Math.max(0, pens);
      const dosesRemaining = pensRemaining * medication.dosesPerUnit;
      const weeksOfSupply = dosesRemaining;
      const lowStock = isLowStock(dosesRemaining);
      inventory = {
        pensRemaining,
        dosesRemaining,
        weeksOfSupply,
        lowStock,
      };
    }

    return apiSuccess({
      doseChanges: medication.doseChanges.map((dc) => ({
        id: dc.id,
        effectiveFrom: dc.effectiveFrom.toISOString(),
        doseValue: dc.doseValue,
        doseUnit: dc.doseUnit,
        note: readNote(dc.noteEncrypted, dc.note),
      })),
      recentIntakes: medication.intakeEvents.map((iv) => ({
        takenAt: iv.takenAt ? iv.takenAt.toISOString() : null,
        injectionSite: iv.injectionSite,
      })),
      inventory,
    });
  },
);

/**
 * POST creates a new dose change OR inventory event (the body picks
 * one — caller specifies which). Convenience endpoint so the
 * medication-card disclosure can write rows without dispatching to
 * /api/medications/[id]/dose-change + /api/medications/[id]/inventory
 * separately for the v1.4.25 cut.
 *
 * Validation: `glp1PostBodySchema` (XOR of `doseChange` / `inventory`),
 * with finite-number guards on `doseValue` + `delta`, bounded `note`
 * + `reason`, and a ±5-year window on `effectiveFrom`.
 * Rate-limit: 30/min/user (same as sibling POST routes).
 * Audit: `medication.glp1.update` for every successful mutation.
 */
/**
 * Wrapped in `withIdempotency`: a titration step is replayed out of the
 * client's offline outbox under the same `Idempotency-Key`, and a replay after
 * a lost success response would otherwise write a second dose change or a
 * second supply delta. Neither row carries a natural key, so the wrapper is the
 * only thing that can collapse the retry.
 */
export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postGlp1Update),
);

async function postGlp1Update(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  // v1.37.0 — MANAGE. A titration step is record data and the dose is what
  // the server acts on; administering one is the case the level names.
  const { user, actor } = await requireRecordAuth("manage", "medications");
  const { id } = await params;

  const guard = await assertMedicationOwnership(id, user.id);
  if (guard) return guard;

  // Per-caller POST rate-limit — matches the 30/min sibling routes
  // (inventory, side-effects). Generous for a hand-driven session,
  // tight enough to cut off the spam case.
  //
  // v1.37.0 — C1: keyed on the ACTOR, so a manager burns their own
  // allowance and cannot collect a fresh one by switching records.
  const rl = await checkRateLimit(
    `medication-glp1:post:${actor.id}`,
    POST_RATE_LIMIT,
    POST_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many requests", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = glp1PostBodySchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

  const ip = getClientIp(request);

  if (parsed.data.doseChange) {
    const { effectiveFrom, doseValue, doseUnit, note } = parsed.data.doseChange;
    const created = await prisma.medicationDoseChange.create({
      data: {
        medicationId: id,
        effectiveFrom,
        doseValue,
        doseUnit,
        // Encrypt the titration note at rest; the plaintext column stays null.
        noteEncrypted: encryptNote(note),
        note: null,
      },
    });

    await auditLog("medication.glp1.update", {
      userId: user.id,
      ipAddress: ip,
      details: {
        medicationId: id,
        kind: "doseChange",
        doseChangeId: created.id,
        doseValue,
        doseUnit,
      },
    });

    annotate({
      action: {
        name: "medication.glp1.doseChange.create",
        entity_type: "medication_dose_change",
        entity_id: created.id,
      },
      meta: { medication_id: id, doseValue, doseUnit },
    });

    // A dose change shifts the daily-dose estimate the list payload's
    // runway derivation uses. Hard-evict the medications + compliance
    // buckets so the card reflects the new runway on the next read.
    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess({ doseChange: shapeDoseChangeNote(created) }, 201);
  }

  // The schema's XOR refinement guarantees `inventory` is present
  // when `doseChange` is not, so the non-null assertion is safe.
  //
  // DEPRECATED branch (v1.16.10): this writes the legacy
  // MedicationInventoryEvent running-sum ledger. The per-item
  // endpoints (`POST /api/medications/[id]/inventory`,
  // `PATCH /api/medications/[id]/inventory/[itemId]`) replaced it;
  // GET above and the Coach snapshot read the ledger only while the
  // medication has zero inventory items. New callers must register
  // containers instead of posting deltas.
  const { delta, reason } = parsed.data.inventory!;
  const created = await prisma.medicationInventoryEvent.create({
    data: { medicationId: id, delta, reason },
  });

  await auditLog("medication.glp1.update", {
    userId: user.id,
    ipAddress: ip,
    details: {
      medicationId: id,
      kind: "inventory",
      inventoryEventId: created.id,
      delta,
      reason,
    },
  });

  annotate({
    action: {
      name: "medication.glp1.inventory.create",
      entity_type: "medication_inventory_event",
      entity_id: created.id,
    },
    meta: { medication_id: id, delta },
  });

  // A legacy ledger delta changes the stock the list payload reports
  // for a medication with no per-item containers. Hard-evict so the
  // card reflects it on the next read.
  invalidateUserMedications(user.id, { evict: true });

  return apiSuccess({ inventory: created }, 201);
}
