/**
 * OpenAPI route table — medications CRUD, intake, cadence, compliance, AI extraction.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import { baseUpdatedAtField } from "../shared";
import {
  MEDICATION_CATEGORY_VALUES,
  MEDICATION_CONTAINER_TYPE_VALUES,
  MEDICATION_TREATMENT_CLASS_VALUES,
} from "@/lib/validations/medication";
import { medicationExtractionSchema } from "@/lib/ai/coach/medication-extract-prompt";
import {
  MEDICATION_LIST_VIEWS,
  MEDICATION_ORDER_ID_MAX_LENGTH,
  MEDICATION_ORDER_MAX_ENTRIES,
} from "@/lib/medication-list-layout";
import { MEDICATION_IMPORT_SKIP_REASONS } from "@/lib/jobs/medication-intake-import";

// ── Medications (v1.5 scheduling) ────────────────────────────────────
//
// The Medication + MedicationSchedule resource shapes documented below
// follow the wire envelope the seven routes registered at the bottom of
// this file emit. `windowStart` / `windowEnd` / `daysOfWeek` /
// `intervalWeeks` are the legacy primitives kept for backwards
// compatibility through the v1.5.x line; `timesOfDay`, `rrule`,
// `rollingIntervalDays`, and `reminderGraceMinutes` are the v1.5
// first-class primitives the wizard + iOS cadence picker write. The
// XOR between `rrule` and `rollingIntervalDays` is documented at the
// schema description AND enforced by the route + a DB CHECK constraint
// so iOS code-gen surfaces the mutual exclusion.

export const medicationCategoryEnum = z.enum(MEDICATION_CATEGORY_VALUES).meta({
  id: "MedicationCategory",
  description:
    "Clinical taxonomy stored in the `medication_categories` side-table. Orthogonal to `MedicationTreatmentClass`.",
});

export const medicationTreatmentClassEnum = z
  .enum(MEDICATION_TREATMENT_CLASS_VALUES)
  .meta({
    id: "MedicationTreatmentClass",
    description:
      "Prisma-level treatment-class discriminator. `GLP1` unlocks the GLP-1 specialist surfaces (injection-site rotation, titration history, pen inventory, GLP-1-aware Coach).",
  });

export const medicationScheduleResource = z
  .object({
    id: z.string(),
    medicationId: z.string(),
    windowStart: z
      .string()
      .describe(
        "Legacy single-time-of-intake (HH:mm, user local). Preserved for backwards compatibility; the new `timesOfDay` array supersedes it.",
      ),
    windowEnd: z
      .string()
      .describe(
        "Legacy reminder-window upper bound (HH:mm). Used to derive the late-classification grace span when `reminderGraceMinutes` is null.",
      ),
    label: z.string().nullable(),
    dose: z
      .string()
      .nullable()
      .describe(
        "Per-schedule dose override. NULL means the schedule inherits `Medication.dose`.",
      ),
    unitsPerDose: z
      .number()
      .nullable()
      .describe(
        "v1.37.10 (#219) — per-slot inventory-units override (may be a split-pill fraction). NULL means the schedule inherits the medication-level `unitsPerDose`. Kept raw so an edit surface can distinguish an explicit value from inheritance; consumers wanting the effective figure read `resolvedUnitsPerDose`.",
      ),
    resolvedUnitsPerDose: z
      .number()
      .describe(
        "v1.37.19 — the EFFECTIVE units one dose of this slot consumes, resolved server-side (`schedule.unitsPerDose ?? medication.unitsPerDose`, matching the intake consumption resolver). Always present; clients never re-derive the inheritance rule.",
      ),
    daysOfWeek: z
      .string()
      .nullable()
      .describe(
        "Legacy persisted recurrence encoding (`null` | `1,3,5` | `i2;1,3,5`). v1.5 readers consult `rrule` first; the field is kept for pre-v1.5 rows. v1.6.0 drops the column.",
      ),
    timesOfDay: z
      .array(z.string())
      .describe(
        "v1.5 first-class points-in-time the dose is taken (HH:mm, user local). Backfilled to `[windowStart]` for every pre-v1.5 row.",
      ),
    reminderGraceMinutes: z
      .number()
      .int()
      .nullable()
      .describe(
        "Reminder grace window in minutes. NULL falls back to the legacy `windowEnd - windowStart` span.",
      ),
    rrule: z
      .string()
      .nullable()
      .describe(
        "RFC 5545 RRULE string (subset). Used for calendar-anchored cadences. **Mutually exclusive with `rollingIntervalDays`** — exactly one of the two is non-null on any v1.5+ schedule (or both are null on legacy rows that haven't been touched since the migration).",
      ),
    rollingIntervalDays: z
      .number()
      .int()
      .nullable()
      .describe(
        "Flexible-rolling interval in days, counted forward from the latest `MedicationIntakeEvent.takenAt`. **Mutually exclusive with `rrule`.**",
      ),
    scheduleType: z
      .enum(["SCHEDULED", "PRN", "CYCLIC"])
      .describe(
        "v1.7.0 schedule-type discriminator. SCHEDULED = rrule / rolling / legacy cadence. PRN = as-needed (never projected, reminded, or counted in compliance expected; still loggable via the intake route). CYCLIC = N weeks on / M weeks off, gating whichever inner cadence the rrule / legacy fields describe.",
      ),
    cyclicOnWeeks: z
      .number()
      .int()
      .nullable()
      .describe(
        'v1.7.0 cyclic "on" weeks. Only meaningful when `scheduleType` is CYCLIC; null otherwise.',
      ),
    cyclicOffWeeks: z
      .number()
      .int()
      .nullable()
      .describe(
        'v1.7.0 cyclic "off" weeks. Only meaningful when `scheduleType` is CYCLIC; null otherwise.',
      ),
  })
  .meta({
    id: "MedicationSchedule",
    description:
      "Schedule entry attached to a medication. v1.5 promotes `timesOfDay` to first-class and introduces `rrule` (calendar-anchored cadences) and `rollingIntervalDays` (flexible-rolling cadences). The two recurrence primitives are mutually exclusive — enforced by the Zod refine on writes, the route layer, and a DB CHECK constraint (`medication_schedules_rrule_xor_rolling`). v1.7.0 adds `scheduleType` (SCHEDULED / PRN / CYCLIC) and the cyclic on/off-week fields.",
  });

export const medicationResource = z
  .object({
    id: z.string(),
    name: z.string(),
    dose: z.string(),
    treatmentClass: medicationTreatmentClassEnum,
    dosesPerUnit: z
      .number()
      .int()
      .nullable()
      .describe(
        "Doses per pen / vial for inventory tracking. NULL = inventory tracking off.",
      ),
    unitsPerDose: z
      .number()
      .describe(
        "v1.16.10 — inventory units one dose consumes (e.g. 2 tablets of 2 mg for a 4 mg dose). v1.16.12 — may be a split-pill fraction (¼ / ⅓ / ½ / ⅔ / ¾); thirds carry as ≈0.3333 / 0.6667. Default 1. The intake consumption hook decrements this many units per taken dose; dose-derived readouts divide unit counts by it.",
      ),
    reorderLeadDays: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.17.0 — optional per-medication reorder lead time in days (0–60). The low-stock alert widens its trigger by this lead plus one dose-interval so a refill arrives before the last dose. null = inherit the user-level notificationPrefs.medication.reorderLeadDays default (10).",
      ),
    active: z.boolean(),
    notificationsEnabled: z.boolean(),
    liveActivityEnabled: z
      .boolean()
      .describe(
        "v1.7.0 iOS Live Activity opt-in for this medication's reminders. Default false. The iOS client owns the ActivityKit lifecycle; the server only stores + echoes the flag.",
      ),
    criticalAlarmEnabled: z
      .boolean()
      .describe(
        "v1.7.0 iOS 26 AlarmKit critical-reminder opt-in. Default false. Critical alarms bypass the device mute switch / Focus; the server stores the preference only.",
      ),
    atcCode: z
      .string()
      .nullable()
      .describe(
        "v1.9.0 optional WHO ATC classification code (active-substance class, e.g. `A10BX10`). User/clinician-asserted; never machine-guessed. Emitted on the FHIR `medicationCodeableConcept` under `http://www.whocc.no/atc`. NULL = no code captured.",
      ),
    rxNormCode: z
      .string()
      .nullable()
      .describe(
        "v1.9.0 optional RxNorm RxCUI (numeric, US identifier, e.g. `2601723`). Secondary FHIR coding under `http://www.nlm.nih.gov/research/umls/rxnorm`, alongside any ATC code. NULL = no code captured.",
      ),
    pausedAt: z.iso.datetime({ offset: true }).nullable(),
    snoozedUntil: z.iso.datetime({ offset: true }).nullable(),
    nextDueAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe(
        "Present on the READ paths only — the list and single GET compute it; the create / update responses return the stored row and omit it. v1.7.0 server-computed next due instant across all the medication's schedules (earliest `nextOccurrenceAfter`). Read-only — computed, not stored. NULL when no schedule has an upcoming slot (paused, one-shot in the past, `endsOn` crossed, every schedule PRN). v1.16.4 — when an unresolved slot's anchor has passed but the catch-up band is still open (`anchor < now <= overdueEnd`, current schedule era), this carries THAT slot (a past instant) with `nextDueOverdue: true` instead of jumping to the next future slot. The list GET is cached 60 s, so a 60 s staleness is accepted.",
      ),
    nextDueOverdue: z
      .boolean()
      .optional()
      .describe(
        "Present on the READ paths only, alongside `nextDueAt`. v1.16.4 — true when `nextDueAt` is an OPEN overdue slot: its anchor has passed, `now` is still inside the slot's catch-up band, and no taken / skipped / auto-missed row resolves it. False for a regular future next-due (and when `nextDueAt` is null). Read-only — computed, not stored.",
      ),
    startsOn: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.5 course start (ISO date). Anchors RRULE BYDAY / BYMONTHDAY patterns and the rolling-interval countdown's first window. NULL means active from creation.",
      ),
    endsOn: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.5 course end (ISO date). NULL means chronic. Equals `startsOn` when `oneShot` is true.",
      ),
    oneShot: z
      .boolean()
      .describe(
        "v1.5 single-administration flag. When true the medication has at most one schedule (no `rrule` / `rollingIntervalDays`), and `active` auto-flips to false once the dose is logged.",
      ),
    asNeeded: z
      .boolean()
      .describe(
        "v1.16.11 as-needed (PRN) flag. When true the medication carries ZERO schedules (the write routes 422 on any schedule entry alongside the flag): it is never due (`nextDueAt` stays null), never reminded, and excluded from every compliance rate/streak — but intakes still log as ad-hoc rows, inventory still consumes per `unitsPerDose`, and the history renders. Stays active indefinitely. Mutually exclusive with `oneShot`.",
      ),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    schedules: z.array(medicationScheduleResource),
  })
  .meta({
    id: "Medication",
    description:
      "Server-shaped medication row returned by GET / POST / PUT endpoints. Carries the v1.5 course-window fields (`startsOn`, `endsOn`, `oneShot`) at the medication level and the per-schedule cadence fields on the nested `schedules` array.",
  });

export const medicationListEntry = medicationResource
  .extend({
    category: medicationCategoryEnum,
    // v1.32.25 — mirrored-medication provenance echoed on the list read so
    // the web UI and an operator can tell a mirror row from a native one.
    externalSource: z
      .literal("APPLE_HEALTH")
      .nullable()
      .describe(
        "v1.32.25 — provenance of the medication. `APPLE_HEALTH` marks the row a read-only mirror of the iOS 26+ HealthKit Medications sync; NULL is a native HealthLog medication. Read-only echo of the stored provenance — the create route sets it, the list read surfaces it so mirrored-vs-native is visible without inspecting the iOS client's local registry.",
      ),
    // The list read always computes these two, so they are required here
    // even though the shared base leaves them optional for the write paths.
    nextDueAt: z.iso.datetime({ offset: true }).nullable(),
    nextDueOverdue: z.boolean(),
    lastTakenAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Latest non-skipped `MedicationIntakeEvent.takenAt` for the medication. Drives the rolling-cadence countdown surface.",
      ),
    todayEventCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of ACTIONED intake events for today (user-local day window): rows with a recorded `takenAt` or an explicit skip. Pending projector-minted rows do not count — the card overdue-pill suppression compares this against the passed-dose count, and a pending mint must not read as covered.",
      ),
    stockUnitsRemaining: z
      .number()
      .nullable()
      .describe(
        "v1.16.10 — usable inventory units left across the medication's containers (sum of `unitsRemaining` over ACTIVE / IN_USE items with units left). NULL = inventory tracking off (no items ever registered); 0 = tracking on, supply ran out. Read-only — aggregated, not stored.",
      ),
    stockDosesRemaining: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.16.10 — dose-derived stock as a whole-dose count. v1.37.19 — slot-aware: the divisor is the schedule-weighted average units per dose (each slot's `resolvedUnitsPerDose` weighted by its cadence share), falling back to the medication-level `unitsPerDose` when no schedule derives a consumption rate. `unitsPerDose` may be a fraction (½ tablet ⇒ twice the doses). NULL when inventory tracking is off. Drives the table view's Bestand column. Read-only — aggregated, not stored.",
      ),
    runwayDays: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.37.19 — projected whole days the usable stock covers under the slot-aware burn rate (the same math the low-stock notification engine runs, so the wire and the push can never disagree). NULL = inventory tracking off or no consuming cadence derivable; 0 = tracking on, supply ran out. Read-only — computed, not stored.",
      ),
  })
  .meta({
    id: "MedicationListEntry",
    description:
      "List-row variant of the medication resource enriched with the joined `category`, the v1.32.25 `externalSource` provenance echo, `lastTakenAt`, `todayEventCount`, and the v1.16.10 aggregated stock fields (`stockUnitsRemaining`, `stockDosesRemaining`) the dashboard + iOS client consume. The base medication fields (`id`, `name`, `dose`, `treatmentClass`, `dosesPerUnit`, `active`, `notificationsEnabled`, `pausedAt`, `snoozedUntil`, `startsOn`, `endsOn`, `oneShot`, `createdAt`, `updatedAt`, `schedules`) are inlined; see the `Medication` component for their semantics.",
  });

export const medicationDetailEntry = medicationResource
  .extend({
    category: medicationCategoryEnum,
    stockUnitsRemaining: z
      .number()
      .nullable()
      .describe(
        "v1.37.19 — usable inventory units left (same semantics as the list entry's field): NULL = inventory tracking off; 0 = tracking on, supply ran out.",
      ),
    stockDosesRemaining: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.37.19 — slot-aware dose-derived stock, mirroring the list entry's field.",
      ),
    runwayDays: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.37.19 — projected whole days the usable stock covers under the slot-aware burn rate; NULL = tracking off or no consuming cadence.",
      ),
  })
  .meta({
    id: "MedicationDetail",
    description:
      "Detail variant of the medication resource enriched with the joined `category`. The base medication fields are inlined; see the `Medication` component for their semantics.",
  });

// v1.16.10 — per-container inventory entity (pen / blister pack /
// bottle). Counts UNITS; the medication's `unitsPerDose` maps units to
// doses. The intake consumption hook decrements `unitsRemaining` per
// taken dose and stamps the intake event with what it consumed.
export const medicationInventoryItemResource = z
  .object({
    id: z.string(),
    userId: z.string(),
    medicationId: z.string(),
    state: z
      .enum(["ACTIVE", "IN_USE", "EXPIRED", "USED_UP"])
      .describe(
        "Container lifecycle state. ACTIVE = unopened; IN_USE = opened (on a PEN / AMPOULE the 30-day in-use clock is running); EXPIRED = printed expiry lapsed, or the in-use window lapsed on a clock-bearing container, with units left; USED_UP = drained (terminal).",
      ),
    containerType: z
      .enum(MEDICATION_CONTAINER_TYPE_VALUES)
      .describe(
        "Kind of physical container (PEN / AMPOULE / BLISTER / INHALER / BOTTLE / OTHER); defaults to OTHER. PEN and AMPOULE are the sealed reservoirs the first dose breaches, so opening one starts a 30-day post-opening window; BLISTER / INHALER / BOTTLE / OTHER hold individually sealed units and expire only on their printed date.",
      ),
    unitsTotal: z
      .number()
      .nullable()
      .describe(
        'Units the container shipped with (tablets / ampoules / puffs; 1–1000). v1.16.12 — fractional, so a split-pill remainder reads cleanly. Dose-derived readouts divide by the medication\'s `unitsPerDose`. v1.18.3 (iOS#31) — NULL when the unit count is unknown (a corrupt or legacy row); the client renders "unknown", never a fabricated 0.',
      ),
    unitsRemaining: z
      .number()
      .nullable()
      .describe(
        'Units left in the container. v1.16.12 — fractional (a ½-tablet dose leaves 29.5 of 30). Decremented by the intake consumption hook (FEFO with spillover across containers); refunded when a taken dose is skipped, edited away, or deleted. v1.18.3 (iOS#31) — NULL when the count is unknown (a corrupt or legacy row); the client renders "unknown", never a fabricated 0 it could decrement into negatives.',
      ),
    firstUseAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Instant the container was first used. NULL until opened. On a PEN / AMPOULE it starts the 30-day in-use clock; on the other kinds it only records that the pack is open.",
      ),
    expiresAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Persisted MIN(firstUseAt + 30 days, printedExpiry) for a clock-bearing container (PEN / AMPOULE), else printedExpiry alone. NULL when no deadline applies — an opened blister with no printed date has none.",
      ),
    printedExpiry: z.iso.datetime({ offset: true }).nullable(),
    purchasedAt: z.iso.datetime({ offset: true }).nullable(),
    manufacturer: z
      .string()
      .nullable()
      .describe(
        "Marketing-authorisation holder / maker as printed on the carton. NULL for a container registered before the field existed, and for plain supply rows that never carried one.",
      ),
    doseStrength: z
      .string()
      .nullable()
      .describe(
        'Strength as printed on the container, e.g. "5 mg/0.5 ml". Free text, not split into a number + unit — pens state strength per dose, per ml, or per cartridge. NULL when unknown.',
      ),
    notes: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MedicationInventoryItem",
    description:
      "One supply container (pen / blister pack / bottle) of a medication. Counts UNITS — the medication's `unitsPerDose` maps units to doses. The intake write paths consume from the open container first, then first-expiry-first-out over unopened stock.",
  });

// v1.19.0 (iOS#25) — server-computed canonical supply summary returned
// alongside the inventory list. Replaces the former client-side
// derivation so web and iOS render identical Bestand figures from one
// DTO. Pools ACTIVE / IN_USE containers with units left; EXPIRED stock
// is surfaced separately and never counts as available.
export const medicationSupplySummaryResource = z
  .object({
    unitsRemaining: z
      .number()
      .describe(
        "Pooled units across available (ACTIVE / IN_USE, units left) containers. Floored at 0 — a corrupt / legacy negative row can never surface a negative Bestand.",
      ),
    unitsTotal: z
      .number()
      .describe("Pooled capacity across the same available containers."),
    dosesRemaining: z
      .number()
      .describe(
        "Dose-derived headline: `floor(unitsRemaining / unitsPerDose)` (whole doses; a partial dose is not a dose).",
      ),
    dosesTotal: z
      .number()
      .describe("Dose-derived capacity: `floor(unitsTotal / unitsPerDose)`."),
    expiredUnits: z
      .number()
      .describe(
        "Units still sitting in EXPIRED containers — visible to the user as a muted suffix, never folded into the available headline or the runway estimate.",
      ),
  })
  .meta({
    id: "MedicationSupplySummary",
    description:
      "Server-authoritative supply summary for a medication's containers. Computed from the same availability predicate the medications-list payload and the GLP-1 endpoint use, so every surface agrees on what 'remaining' means.",
  });

export const medicationIntakeEventResource = z
  .object({
    id: z.string(),
    userId: z.string(),
    medicationId: z.string(),
    scheduledFor: z.iso.datetime({ offset: true }),
    takenAt: z.iso.datetime({ offset: true }).nullable(),
    skipped: z.boolean(),
    autoMissed: z
      .boolean()
      .describe(
        "True when the nightly cron closed the slot as missed (no user action). Auto-missed rows count against adherence but never consume inventory.",
      ),
    attributionSource: z
      .enum(["AUTO", "USER_PIN"])
      .describe(
        "How the row bound to its schedule slot: AUTO = the write path's nearest-slot resolution; USER_PIN = the user explicitly pinned the slot (the dedup converge keeps the pinned row).",
      ),
    source: z.enum(["WEB", "API", "REMINDER", "IMPORT", "APPLE_HEALTH"]),
    idempotencyKey: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    injectionSite: z
      .enum([
        "ABDOMEN_LEFT",
        "ABDOMEN_RIGHT",
        "ABDOMEN_UPPER_LEFT",
        "ABDOMEN_UPPER_RIGHT",
        "THIGH_LEFT",
        "THIGH_RIGHT",
        "UPPER_ARM_LEFT",
        "UPPER_ARM_RIGHT",
      ])
      .nullable()
      .describe(
        "Recorded injection site for a site-tracked medication (GLP-1 rotation surface). NULL when the medication does not track sites or none was recorded.",
      ),
    doseTaken: z
      .string()
      .nullable()
      .describe(
        "Free-text dose actually taken when it differed from the scheduled dose (titration weeks, split doses). NULL = the scheduled dose.",
      ),
    inventoryConsumption: z
      .unknown()
      .nullable()
      .describe(
        "JSON ledger of the container decrements this intake caused (`[{itemId, units}]`), written by the consumption hook. NULL when nothing was consumed (skipped / no tracked inventory).",
      ),
    externalId: z
      .string()
      .nullable()
      .describe(
        "v1.28 — client-supplied stable id for externally-mirrored intakes (Apple Health sync); the dedup key for re-synced rows. NULL for native rows.",
      ),
    syncVersion: z
      .number()
      .int()
      .describe(
        "Monotonic per-row version for incremental sync readers; bumps on every mutation.",
      ),
    deletedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Soft-delete tombstone. Non-null rows are excluded from every list/aggregate read; sync readers use it to propagate deletions.",
      ),
  })
  .meta({
    id: "MedicationIntakeEvent",
    description:
      "Single dose log row — the FULL row shape both the intake POST (201/200) and the intake list GET return. `takenAt` is non-null for confirmed intakes; `skipped:true` represents a deliberately-missed dose (no inventory consumption).",
  });

export const medicationCadenceTimelinePoint = z
  .object({
    day: z.iso.datetime({ offset: true }),
    windowStart: z.iso.datetime({ offset: true }),
    windowEnd: z.iso.datetime({ offset: true }),
    scheduleIndex: z.number().int().nonnegative(),
    status: z.string(),
  })
  .meta({
    id: "MedicationCadenceTimelinePoint",
    description:
      "One expected-vs-actual dose slot for the cadence timeline chart. `status` is one of `taken | skipped | missed | pending | future` and drives the chip colour.",
  });

export const medicationCadenceChips = z
  .object({
    adherenceRate: z
      .number()
      .nullable()
      .describe(
        "0-100, taken / (taken + missed). Skipped doses are excluded from the denominator — a deliberate decision, not a compliance failure. NULL when no dose was expected in the window (brand-new medication, paused).",
      ),
    currentStreak: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Consecutive days ending at `asOf` where every expected dose was taken or skipped. Days with no expected dose advance the streak; missed days break it.",
      ),
    longestStreak: z
      .number()
      .int()
      .nonnegative()
      .describe("Longest all-taken-or-skipped run anywhere in the window."),
    missedLast30: z
      .number()
      .int()
      .nonnegative()
      .describe("Count of missed doses inside the window."),
    windowDays: z
      .number()
      .int()
      .nonnegative()
      .describe("Window size used — mirrors the input for the chart legend."),
  })
  .meta({
    id: "MedicationCadenceChips",
    description:
      "Compliance summary values for the medication detail page chip row.",
  });

export const medicationCadenceResponse = z
  .object({
    windowDays: z.number().int().positive(),
    anchorIso: z.iso.datetime({ offset: true }),
    next: z
      .object({
        windowStart: z.iso.datetime({ offset: true }),
        windowEnd: z.iso.datetime({ offset: true }),
        scheduleIndex: z.number().int().nonnegative(),
      })
      .nullable(),
    chips: medicationCadenceChips,
    timeline: z.array(medicationCadenceTimelinePoint),
  })
  .meta({
    id: "MedicationCadenceResponse",
    description:
      "Cadence + compliance read for a single medication. `next` is the upcoming-dose envelope (null when the course has ended or the rolling clock has no pinning intake yet); `timeline` walks the requested `windowDays` worth of slots in ascending time order.",
  });

export const complianceResult = z
  .object({
    totalExpected: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Full denominator over the window: `taken + skipped + missed`. Cadence-aware. A slot from before the medication's `createdAt` counts only when a recorded dose (a take or a skip) claims it, so the days before the medication existed are never missed.",
      ),
    taken: z.number().int().nonnegative(),
    skipped: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Doses the user explicitly skipped — excluded from the `rate` denominator.",
      ),
    missed: z.number().int().nonnegative(),
    rate: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe(
        "Adherence percentage `round(taken / (taken + missed) * 100)` — `skipped` is excluded from the denominator.",
      ),
    streak: z
      .number()
      .int()
      .nonnegative()
      .describe("Consecutive days with every due dose taken."),
  })
  .meta({
    id: "ComplianceResult",
    description:
      "Rolling-window adherence summary. `compliance30` is the authoritative 'last 30 days, taken vs expected' read — clients should display `rate` and use `totalExpected` as the denominator rather than re-deriving it from the daily map.",
  });

export const dailyComplianceEntry = z
  .object({
    expected: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Engine-computed due-slot count for the day. Equals `expectedCount`; kept for existing consumers.",
      ),
    expectedCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "True due-slot count for the day (additive field clients key off so they don't infer due-ness from `expected`).",
      ),
    due: z
      .boolean()
      .describe(
        "`expectedCount > 0`. Paint a per-day glyph as expected/missed ONLY when `due === true`; off-cadence / pre-creation / PRN days are not misses.",
      ),
    taken: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    onTime: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Doses taken in the on-time band, including the `early` bucket (early counts as compliant).",
      ),
    late: z.number().int().nonnegative(),
    veryLate: z.number().int().nonnegative(),
    early: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Doses taken before the on-time band's grace start; already folded into `onTime`, surfaced separately for consumers that differentiate.",
      ),
  })
  .meta({
    id: "DailyComplianceEntry",
    description:
      "Per-day compliance cell with the timing breakdown that drives the history glyph track.",
  });

export const complianceDisplay = z
  .object({
    shortDays: z.number().int().positive(),
    longDays: z.number().int().positive(),
    expectedShort: z.number().int().nonnegative(),
    expectedLong: z.number().int().nonnegative(),
    minStableDoses: z.number().int().nonnegative(),
    short: z.object({
      rate: z.number().int().min(0).max(100),
      taken: z.number().int().nonnegative(),
      expected: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "v1.15.9 rate denominator over the short window (`taken + missed`); user skips are excluded. Render `taken / expected · rate%`.",
        ),
      missed: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "v1.15.9 doses counted against the rate over the short window — includes forgotten doses the auto-miss cron flipped.",
        ),
      streak: z.number().int().nonnegative(),
    }),
    long: z.object({
      rate: z.number().int().min(0).max(100),
      taken: z.number().int().nonnegative(),
      expected: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "v1.15.9 rate denominator over the long window (`taken + missed`).",
        ),
      missed: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "v1.15.9 doses counted against the rate over the long window.",
        ),
    }),
    currentCycle: z
      .object({
        state: z
          .enum(["on_track", "due", "missed", "none"])
          .describe(
            "Open-cycle state, decoupled from the percentage rows: `on_track` = next dose not yet due; `due` = due now / in grace; `missed` = past grace with no logged intake (the only red state); `none` = no projected next dose (PRN / paused / ended).",
          ),
        nextDueAt: z.iso
          .datetime({ offset: true })
          .nullable()
          .describe(
            "The open cycle's due instant. Null when `state` is `none`.",
          ),
        graceUntil: z.iso
          .datetime({ offset: true })
          .nullable()
          .describe(
            "End of the due slot's grace window. Null when `state` is `none`.",
          ),
        hasClosedCycles: z
          .boolean()
          .describe(
            "False for a brand-new sparse med with zero closed dose cycles — the percentage rows are vacuous and the card should show a neutral 'not enough data yet' state.",
          ),
      })
      .describe(
        "v1.13.x — the current (open) dose cycle, surfaced so a between-doses sparse med renders a neutral 'next dose in N days' line instead of a scary red 0%. The percentage rows above already exclude the open forward cycle from their denominator.",
      ),
    currentDose: z
      .object({
        status: z
          .enum([
            "upcoming",
            "on_time_window",
            "overdue",
            "missed",
            "taken_on_time",
            "taken_late",
            "skipped",
          ])
          .describe(
            "Per-dose state of the open cycle, server-derived from the window model so the card renders the take-window (green) / overdue / heavily-overdue escalation from one authority. `upcoming` when no dose is open (PRN / paused / ended).",
          ),
        targetAt: z.iso
          .datetime({ offset: true })
          .nullable()
          .describe(
            "Target instant of the open dose. Null when no dose is open.",
          ),
      })
      .describe(
        "v1.15.9 — the open dose's per-dose status + target, so the card highlights the actionable take-window green and escalates an overdue dose without re-deriving the window math client-side.",
      ),
  })
  .meta({
    id: "ComplianceDisplay",
    description:
      "The two-row card block whose windows scale with dosing cadence (dense meds keep 7 / 30 days, sparse meds step both windows up). NOT the 30-day denominator — read `compliance30.totalExpected` for that.",
  });

export const medicationComplianceResponse = z
  .object({
    applicable: z
      .boolean()
      .describe(
        "Whether a local adherence percentage applies to this medication.",
      ),
    notApplicableReason: z
      .literal("NO_LOCAL_SCHEDULE")
      .nullable()
      .describe(
        "Reason adherence is not applicable. NO_LOCAL_SCHEDULE means the medication has no HealthLog-owned expected-dose grid.",
      ),
    compliance7: complianceResult.describe(
      "Seven-day adherence summary. When applicable is false, this remains a non-null all-zero compatibility placeholder for released clients and must not be rendered as a percentage.",
    ),
    compliance30: complianceResult.describe(
      "Thirty-day adherence summary. When applicable is false, this remains a non-null all-zero compatibility placeholder for released clients and must not be rendered as a percentage.",
    ),
    dailyCompliance: z
      .record(z.string(), dailyComplianceEntry)
      .describe(
        "Flat per-day map keyed YYYY-MM-DD in the user timezone. Empty when adherence is not applicable.",
      ),
    complianceDisplay: complianceDisplay
      .nullable()
      .describe(
        "Cadence-scaled display block, or null when adherence is not applicable.",
      ),
  })
  .meta({
    id: "MedicationComplianceResponse",
    description:
      "Adherence read for a single medication. A scheduled medication with no local schedule returns applicable=false and NO_LOCAL_SCHEDULE rather than a vacuous 100 percent. Scheduled medications that have a local schedule keep the existing cadence-aware arithmetic, including windows with no doses due. PRN behaviour is unchanged.",
  });

export const medicationComplianceSummaryEntry = z
  .object({
    medicationId: z.string(),
    applicable: z
      .boolean()
      .describe(
        "Whether this medication has a local expected-dose grid and therefore a displayable adherence percentage.",
      ),
    notApplicableReason: z.literal("NO_LOCAL_SCHEDULE").nullable(),
    compliance7: complianceResult.describe(
      "Seven-day adherence summary, or an all-zero compatibility placeholder when applicable is false.",
    ),
    compliance30: complianceResult.describe(
      "Thirty-day adherence summary, or an all-zero compatibility placeholder when applicable is false.",
    ),
    complianceDisplay: complianceDisplay.nullable(),
  })
  .meta({
    id: "MedicationComplianceSummaryEntry",
    description:
      "Compact per-medication adherence row for the batched card read. Zero-local-schedule scheduled medications remain present with applicable=false so clients render a settled not-applicable state instead of a loading skeleton.",
  });

// v1.16.5 — schedule-era management (the Zeitplan-tab history timeline).
// Archived eras come from two provenances: the wholesale-replace write
// path (`ARCHIVED`, immutable) and the user-entered pre-tracking flow
// (`MANUAL`, deletable through the `[revisionId]` DELETE).
export const scheduleRevisionEntrySummary = z
  .object({
    timesOfDay: z
      .array(z.string())
      .describe("Daily dose times (HH:mm, user local) the era ran at."),
    label: z.string().nullable(),
    dose: z.string().nullable(),
    scheduleType: z
      .string()
      .describe(
        "Schedule-type discriminator of the archived row (SCHEDULED / PRN / CYCLIC).",
      ),
  })
  .meta({
    id: "ScheduleRevisionEntry",
    description:
      "Display summary of one archived schedule row inside an era. The full snapshot (windows, rrule, doseWindows, …) stays server-side; this projection carries what the timeline renders.",
  });

export const scheduleRevisionResource = z
  .object({
    id: z.string(),
    validFrom: z.iso.datetime().describe("Inclusive start instant of the era."),
    validUntil: z.iso
      .datetime()
      .describe(
        "Exclusive end instant of the era — the moment the next plan took over.",
      ),
    source: z
      .enum(["ARCHIVED", "MANUAL"])
      .describe(
        "Provenance. ARCHIVED = minted by the schedule-replace write path (immutable). MANUAL = user-entered pre-tracking era (deletable).",
      ),
    entries: z.array(scheduleRevisionEntrySummary),
  })
  .meta({
    id: "MedicationScheduleRevision",
    description:
      "One archived schedule era covering `[validFrom, validUntil)`. The dose-history ledger, compliance tallies, and cadence chips mint past days against the era that was live then.",
  });

export const scheduleRevisionListResponse = z.object({
  currentSince: z.iso
    .datetime()
    .describe(
      "Instant the LIVE plan took over: the newest revision's `validUntil`, or the medication's `createdAt` when no era has been archived.",
    ),
  revisions: z
    .array(scheduleRevisionResource)
    .describe("Archived eras, newest first."),
});

// v1.5.0 — natural-language medication extraction route. The wizard's
// optional "Beschreiben" overlay POSTs a free-text description and
// receives a partial structured payload the form merges onto whatever
// the user already typed. Citation-guarded (`name` and `dose` are
// dropped when not substring-matched in the original text) and
// closed-enum-validated.
export const medicationExtractRequest = z
  .object({
    text: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "Free-text medication description (any locale). Up to 2 000 characters. The model never echoes the text back into another tenant — it is only used to produce the structured fields.",
      ),
    locale: z
      .enum(["en", "de", "es", "fr", "it", "pl", "ko"])
      .optional()
      .describe("Optional UI locale hint for the model."),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Optional override of the reference date used to resolve relative phrases ("tomorrow", "next Monday"). Format: `YYYY-MM-DD`. Defaults to the server\'s UTC day.',
      ),
  })
  .meta({
    id: "MedicationExtractRequest",
    description:
      "Free-text medication description payload. The route runs the text through the Coach provider chain and returns a partial structured payload the wizard merges. Rate-limited 10 requests / 5 minutes / user; budget-gated against the daily Coach token ceiling.",
  });

// v1.15.18 — traceable dose-history read (the "Verlauf" tab ledger). Additive
// GET; iOS-consumed. Transcribed from the handler's `SerializedDoseHistoryRow`
// / response in `src/app/api/medications/[id]/dose-history/route.ts`. v1.32.8
// (iOS #64) adds `intake.source` so a client can label how each dose was
// recorded.
export const doseHistoryQuery = z.object({
  from: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      "Window start (inclusive). Defaults to 90 days before `to`; clamped to a 366-day span floor. Recorded doses are returned from this instant. A slot from before the medication's `createdAt` appears only when a recorded dose (a take or a skip) claims it; the pending placeholder of such a slot is not returned.",
    ),
  to: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      "Window end (inclusive). Defaults to now. Must be ≥ `from`. A dose recorded ahead of its slot (the slot's time within a day after `to`) is still returned.",
    ),
});

const doseHistoryRow = z
  .object({
    kind: z
      .enum(["slot", "ad_hoc"])
      .describe(
        "`slot` — a scheduled dose window; `ad_hoc` — a standalone off-schedule intake.",
      ),
    at: z.iso
      .datetime({ offset: true })
      .describe("The slot anchor instant, or the ad-hoc take's own time."),
    timeOfDay: z
      .string()
      .nullable()
      .describe("The slot's `HH:mm` label, or null for an ad-hoc row."),
    status: z.enum([
      "taken_on_time",
      "taken_late",
      "skipped",
      "missed",
      "upcoming",
      "ad_hoc",
    ]),
    pinned: z
      .boolean()
      .optional()
      .describe(
        "Present and true when the row is served by a deliberate user pin ('zugeordnet').",
      ),
    nearestSlot: z
      .object({
        at: z.iso.datetime({ offset: true }),
        timeOfDay: z.string(),
        filled: z.boolean(),
      })
      .optional()
      .describe(
        "Due-context for an ad-hoc take: the nearest slot it could belong to (preferring an unserved one). `filled` false means the slot can still be offered for pinning.",
      ),
    intake: z
      .object({
        id: z.string().nullable(),
        scheduledFor: z.iso.datetime({ offset: true }),
        takenAt: z.iso.datetime({ offset: true }).nullable(),
        skipped: z.boolean(),
        autoMissed: z.boolean(),
        doseTaken: z
          .string()
          .nullable()
          .describe("Per-intake dose override; null = configured dose."),
        source: z
          .enum(["WEB", "API", "REMINDER", "IMPORT", "APPLE_HEALTH"])
          .nullable()
          .describe(
            "v1.32.8 (iOS #64) — how the dose was recorded: `WEB` (browser), `API` (Bearer / native app), `REMINDER` (the medication reminder worker), `IMPORT` (CSV importer), `APPLE_HEALTH` (the HealthKit dose-event mirror). Null on legacy rows written before the column carried a value. Derived server-side from the write transport, never client-asserted.",
          ),
      })
      .nullable()
      .describe("The intake attributed to this row, if any."),
  })
  .meta({ id: "DoseHistoryRow" });

export const doseHistoryResponse = z
  .object({
    from: z.iso
      .datetime({ offset: true })
      .describe(
        "Start of the window recorded doses were read over: the requested `from` after the span clamp.",
      ),
    to: z.iso
      .datetime({ offset: true })
      .describe(
        "End of the window recorded doses were read over: the requested `to`, or the slot time of a dose recorded ahead of its slot when that lies later (at most one day after `to`).",
      ),
    family: z
      .enum(["daily", "weekly", "one_shot", "none"])
      .describe("Cadence family the window's slots were minted under."),
    hasExpectedSlots: z.boolean(),
    rows: z.array(doseHistoryRow),
  })
  .meta({
    id: "DoseHistoryResponse",
    description:
      "Per-slot dose ledger over [from, to]: every expected slot with a status plus every off-schedule intake tagged ad-hoc. Built from the same band minter + `reconstructDoseHistory` the compliance % consumes, so the history view and the rate never contradict each other.",
  });

// Zod 4's `.meta()` returns a NEW instance carrying the id rather than
// annotating in place, so the annotated clone is exported and the path table
// references it — a bare call would register nothing.
export const medicationExtractionResult = medicationExtractionSchema.meta({
  id: "MedicationExtractionResult",
  description:
    "Citation-guarded partial extraction of medication scheduling fields. Every field is optional; the wizard merges what is present onto the form state and leaves the rest blank. `name` and `dose` are post-validated against the original free-text and dropped when not substring-matched, so the wizard cannot silently land a hallucinated brand or dose. `cadenceKind` / `doseUnit` / `weekdays` are closed enums; numeric fields are clamped to the wizard's wire bounds.",
});

// v1.16.10 — medications list presentation (cards/table view + manual
// order), persisted per user in its own `User` column following the
// dashboard-widgets / insights-layout per-surface convention.
export const medicationListLayoutSchema = z
  .object({
    version: z.literal(1),
    view: z
      .enum(MEDICATION_LIST_VIEWS)
      .optional()
      .describe(
        'Which presentation /medications renders in. Default "cards". Optional on PUT — when omitted the stored value is preserved (preserve-when-absent, like `chartOverlayPrefs` on the dashboard layout). Always present on responses.',
      ),
    order: z
      .array(z.string().min(1).max(MEDICATION_ORDER_ID_MAX_LENGTH))
      .max(MEDICATION_ORDER_MAX_ENTRIES)
      .optional()
      .describe(
        "User-defined manual medication order (medication ids, first = top), shared by both views. Display-only — unknown / deleted ids are ignored at render time, never 422. Optional on PUT (preserve-when-absent); always present on responses.",
      ),
  })
  .meta({
    id: "MedicationListLayout",
    description:
      "Per-user /medications presentation: the card/table view choice plus the manual medication order shared by both views. Mirrors the dashboard-widgets / insights-layout contract.",
  });

// v1.32.21 (R5a) — the PUT body additionally carries the optional
// optimistic-concurrency base token (stripped pre-Zod at runtime by
// `takeBaseToken`); GET / PUT responses echo the fresh `updatedAt` token.
export const medicationListLayoutPutBody = medicationListLayoutSchema
  .extend({ baseUpdatedAt: baseUpdatedAtField })
  .meta({
    id: "MedicationListLayoutPutBody",
    description:
      "PUT body for the medications list presentation — the presentation fields plus the optional optimistic-concurrency base token (`baseUpdatedAt`). Omit the token for the legacy unconditional write.",
  });

export const medicationListLayoutResult = medicationListLayoutSchema
  .extend({
    updatedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Optimistic-concurrency token: the stored row's `updatedAt` at read/write time. Echo it back as `baseUpdatedAt` on the next write. Opaque.",
      ),
  })
  .meta({
    id: "MedicationListLayoutResult",
    description:
      "Resolved medications list presentation plus the optimistic-concurrency `updatedAt` token.",
  });

// ── Intake-import jobs (v1.33.0) — the per-medication `/api/medications/{id}/
// intake/import` route and the account-wide `/api/medications/intake/
// dose-history-import` route both queue onto `MedicationIntakeImportJob` and
// are polled through the SAME status projection, so the shapes below are
// shared rather than duplicated per route.

// The 16-reason closed set a row can be refused for, exactly as declared in
// `MEDICATION_IMPORT_SKIP_REASONS`. `duplicate_in_file` / `already_recorded`
// are dedup outcomes; `medication_not_found` / `medication_ambiguous` /
// `medication_is_mirrored` / `missing_medication` are medication-matching
// outcomes; `status_*` are source rows whose own status column said the dose
// was never taken (a reminder, an unsent notification, an unrecognised
// status); `missing_timestamp` / `missing_timezone_offset` /
// `unreadable_timestamp` / `implausible_timestamp` are timestamp problems;
// `unreadable_dosage` / `unreadable_row` are malformed cells.
export const medicationImportSkipReasonEnum = z
  .enum(MEDICATION_IMPORT_SKIP_REASONS)
  .meta({
    id: "MedicationImportSkipReason",
    description:
      "Why one source row did not become an intake row. Closed 16-value set: duplicate_in_file, already_recorded, medication_not_found, medication_ambiguous, medication_is_mirrored, status_no_dose_information, status_reminder_event, status_notification_not_sent, status_unknown, missing_timestamp, missing_timezone_offset, unreadable_timestamp, implausible_timestamp, missing_medication, unreadable_dosage, unreadable_row.",
  });

const medicationImportSkipGroup = z
  .object({
    reason: medicationImportSkipReasonEnum,
    count: z.number().int().min(1),
  })
  .meta({ id: "MedicationImportSkipGroup" });

const medicationImportSkipDetail = z
  .object({
    line: z.number().int().describe("1-based source-file row ordinal."),
    reason: medicationImportSkipReasonEnum,
  })
  .meta({
    id: "MedicationImportSkipDetail",
    description:
      "One refused source row, reduced to the ordinal + reason — never the row's own content (no medication name, timestamp, or dosage text).",
  });

// The terminal, persisted result. Reconstructed through a strict allowlist
// (`projectMedicationImportResult`) before it ever reaches a polling
// response, so a compromised or legacy JSON blob cannot smuggle anything
// past this shape.
export const medicationImportResult = z
  .object({
    imported: z.number().int().min(0),
    skipped: z
      .number()
      .int()
      .min(0)
      .describe("Total entries that did not become a row."),
    skipReasons: z
      .array(medicationImportSkipGroup)
      .describe(
        "One entry per reason that actually occurred, count descending then reason — never the same sentence repeated per row. Empty when nothing was skipped.",
      ),
    skipDetails: z
      .array(medicationImportSkipDetail)
      .optional()
      .describe(
        "First bounded source-row details (capped at 200). Absent on a legacy job run before this field existed.",
      ),
    skippedDetailsOmitted: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Count of additional skipped rows beyond the `skipDetails` cap, counted without retaining their contents. Absent when nothing was omitted.",
      ),
  })
  .meta({
    id: "MedicationImportResult",
    description:
      "The finished job's outcome. Null while the job is still queued or running — `status` + `progress` are the fields to read meanwhile.",
  });

// The in-flight progress blob a running/queued job carries. Written whole at
// admission time and advanced by the worker in place; unlike `result` it is
// NOT re-validated on read (stored as a bare JSON column), so this documents
// the shape the job worker actually writes rather than a server-enforced
// contract.
export const medicationImportProgress = z
  .object({
    processed: z
      .number()
      .int()
      .min(0)
      .describe("Entries the worker has walked so far, in file order."),
    total: z.number().int().min(0).describe("Entries queued for this job."),
    imported: z
      .number()
      .int()
      .min(0)
      .describe("Entries that have reached the database so far."),
    skippedByReason: z
      .partialRecord(medicationImportSkipReasonEnum, z.number().int().min(1))
      .describe(
        "Running skip tally by reason. A reason with no skips yet is absent from the object, never present as 0.",
      ),
    skipDetails: z
      .array(medicationImportSkipDetail)
      .optional()
      .describe("Same bounded detail list as the finished `result`."),
    skippedDetailsOmitted: z.number().int().min(0).optional(),
    touchedDays: z
      .array(z.string())
      .describe(
        "Local calendar days (YYYY-MM-DD) touched so far, driving the chunked rollup recompute behind the write.",
      ),
    rollupProcessed: z
      .number()
      .int()
      .min(0)
      .describe("Of `touchedDays`, how many have had their rollup recomputed."),
  })
  .meta({
    id: "MedicationImportProgress",
    description:
      "In-flight job progress, written whole at admission and advanced in place by the worker. Present from the moment the job is created (queued), so `processed: 0, total: N` is the shape a client sees immediately after kickoff, not an empty object.",
  });

export const medicationIntakeImportJobStatusResponse = z
  .object({
    jobId: z.string(),
    status: z
      .enum(["queued", "running", "done", "failed"])
      .describe(
        "queued — admitted, not yet picked up. running — the worker is walking entries. done — finished (see `result` for the outcome, even a fully-refused run). failed — the worker could not complete the run (see `failureReason`).",
      ),
    progress: medicationImportProgress,
    result: medicationImportResult
      .nullable()
      .describe("Set only once `status` is `done`; null before that."),
    failureReason: z
      .string()
      .nullable()
      .describe("Set only when `status` is `failed`; null otherwise."),
    createdAt: z.iso.datetime({ offset: true }),
    startedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the worker picked the job up; null while still queued."),
    completedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the job reached `done` or `failed`; null while active."),
  })
  .meta({
    id: "MedicationIntakeImportJobStatusResponse",
    description:
      "Poll target for a queued intake-import job — shared by the per-medication import and the account-wide dose-history import, so a client polls both through one shape.",
  });

// ── Account-wide dose-history import (v1.33.0) ───────────────────────

// The file-level verdict, identical for a dry run and a real submission.
const medicationDoseHistoryImportFile = z
  .object({
    rowsRead: z
      .number()
      .int()
      .min(0)
      .describe("Data rows read from the file, refusals included."),
    queued: z
      .number()
      .int()
      .min(0)
      .describe("Rows that parsed and matched a medication."),
    refused: z
      .number()
      .int()
      .min(0)
      .describe("Total rows that did not queue, across every reason."),
    refusedByReason: z
      .array(medicationImportSkipGroup)
      .describe(
        "One entry per reason that actually occurred, count descending then reason.",
      ),
    unmatchedMedications: z
      .array(z.string())
      .max(50)
      .describe(
        "Medication names the file used that match nothing on the record, deduplicated, first-seen order, capped at 50.",
      ),
    ambiguousMedications: z
      .array(z.string())
      .max(50)
      .describe(
        "Names that match more than one medication, so no single one can be meant. Capped at 50.",
      ),
    mirroredMedications: z
      .array(z.string())
      .max(50)
      .describe(
        "Names that match only a medication mirrored from an external list. Capped at 50.",
      ),
    unknownColumns: z
      .array(z.string())
      .max(50)
      .describe("Header cells the importer has no verdict for. Capped at 50."),
    codingsNotRead: z
      .number()
      .int()
      .min(0)
      .describe("Rows whose `Codings` cell held something left unread."),
    fromArchivedMedications: z
      .number()
      .int()
      .min(0)
      .describe(
        "Rows the file marked as belonging to a medication archived in the source.",
      ),
  })
  .meta({ id: "MedicationDoseHistoryImportFile" });

export const medicationDoseHistoryImportResponse = z
  .object({
    dryRun: z.boolean(),
    jobId: z
      .string()
      .nullable()
      .describe("Null on a dry run (nothing was queued)."),
    status: z
      .literal("queued")
      .optional()
      .describe("Present only on a real (non-dry-run) submission."),
    statusUrl: z
      .string()
      .nullable()
      .describe(
        "Relative poll path (`/api/medications/intake/dose-history-import/{jobId}/status`). Null on a dry run.",
      ),
    file: medicationDoseHistoryImportFile,
  })
  .meta({
    id: "MedicationDoseHistoryImportResponse",
    description:
      "The file-level verdict, plus the queued job pointer on a real submission. A dry run (`?dryRun=1`) returns the same `file` verdict with `jobId`/`statusUrl` null and no `status` field — parses, matches, and reports without writing anything.",
  });

// The 5 file-level (whole-submission) refusal reasons — distinct from the
// 16 per-row `medicationImportSkipReasonEnum` above. `application/json` is
// accepted at the content-type check, but the documented JSON export shape
// always ends in `json_carries_no_intake_time`: it carries `scheduledDate` +
// `status` + `dosage` but no field for when a dose was actually taken, and
// writing the scheduled time as `takenAt` would manufacture an on-time
// history the file never claimed. `text/csv` is the only shape that
// actually imports.
export const medicationDoseHistoryImportFatalReasonEnum = z
  .enum([
    "empty_file",
    "missing_required_columns",
    "unreadable_json",
    "json_not_an_array",
    "json_carries_no_intake_time",
  ])
  .meta({
    id: "MedicationDoseHistoryImportFatalReason",
    description:
      "Whole-file refusal reason on the 422 `errorCode`. empty_file — no data rows. missing_required_columns — the CSV header is missing a column the parser needs. unreadable_json — the body did not parse as JSON. json_not_an_array — parsed JSON is not an array (and no nested array was found under any key). json_carries_no_intake_time — well-formed JSON export input, refused by design (see above).",
  });

// ── The top-level intake aggregator (`/api/medications/intake`) ───────
//
// Two scopes behind one GET plus the status toggle every dose surface posts
// to. Never registered until now: `openapi:check` compares the registry
// against the YAML and never the route tree against the registry.

export const todayIntakeEntry = z
  .object({
    id: z.string().describe("Intake-event id."),
    medicationId: z.string(),
    scheduledAt: z.iso
      .datetime({ offset: true })
      .describe(
        "The slot the dose belongs to — the event's `scheduledFor`, renamed on this wire only.",
      ),
    takenAt: z.iso.datetime({ offset: true }).nullable(),
    status: z
      .enum(["skipped", "taken", "missed", "pending", "snoozed"])
      .describe(
        "Resolved in that precedence order. `missed` is TERMINAL — the nightly cron closed a never-acted slot — and is not a `pending` that can still be answered. `snoozed` is not a property of this event at all: it reflects the MEDICATION's deferral stamp still lying in the future, so every pending dose of that medication reads snoozed at once.",
      ),
    snoozedUntil: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "The medication's deferral stamp, repeated on each of its events. Null when the medication is not deferred.",
      ),
  })
  .meta({
    id: "TodayIntakeEntry",
    description:
      "One of today's dose slots, flattened for the dose sheet and the dashboard tile. A deliberately narrow projection — not the full intake-event row.",
  });

export const complianceDayBucket = z
  .object({
    date: z.string().describe("`YYYY-MM-DD` in the account's timezone."),
    scheduled: z
      .number()
      .int()
      .describe(
        "Doses the SCHEDULE expected that day, from the recurrence engine — not the count of logged rows. That distinction is the point of the field: counting rows made every window read ~100 % because each logged dose was both numerator and denominator.",
      ),
    taken: z.number().int().describe("Doses actually taken that day."),
  })
  .meta({
    id: "MedicationComplianceDayBucket",
    description:
      "One day of schedule-anchored compliance. Paused days drop out of the denominator, and archived schedule eras are honoured, so `scheduled` reflects what was actually expected at the time.",
  });

// ── GLP-1 detail (`/api/medications/{id}/glp1`) ───────────────────────

export const glp1DoseChange = z
  .object({
    id: z.string(),
    effectiveFrom: z.iso.datetime({ offset: true }),
    doseValue: z.number(),
    doseUnit: z.string(),
    note: z
      .string()
      .nullable()
      .describe(
        "Titration note, decrypted on read. Null when none was recorded.",
      ),
  })
  .meta({
    id: "Glp1DoseChange",
    description:
      "One titration step, oldest first. The note is encrypted at rest and the plaintext column is left null on every write this endpoint makes.",
  });

export const glp1Inventory = z
  .object({
    pensRemaining: z
      .number()
      .int()
      .nullable()
      .describe("Usable containers (ACTIVE or IN_USE with units left)."),
    dosesRemaining: z
      .number()
      .int()
      .nullable()
      .describe(
        "Pooled units divided by the medication's `unitsPerDose`, floored — consumption spills across containers.",
      ),
    weeksOfSupply: z
      .number()
      .int()
      .nullable()
      .describe(
        "Equal to `dosesRemaining`. It is the weekly-cadence approximation the canonical GLP-1 case makes, and it is NOT re-derived for a medication on any other cadence.",
      ),
    lowStock: z
      .boolean()
      .describe(
        "The same reorder-lead-aware runway evaluation the daily low-stock notification runs, so the card and the notification cannot disagree. False whenever the low-stock alert is switched off, and false when no schedule consumes the medication (no consumption means no runway, which is not the same as plenty).",
      ),
  })
  .meta({
    id: "Glp1Inventory",
    description:
      "Running supply math. Computed over the per-container entities when any exist; otherwise, and only then, over the legacy running-sum ledger. Containers always win — the ledger never overrides them.",
  });

export const glp1DetailResponse = z
  .object({
    doseChanges: z
      .array(glp1DoseChange)
      .describe("Full titration history, `effectiveFrom` ascending."),
    recentIntakes: z
      .array(
        z.object({
          takenAt: z.iso.datetime({ offset: true }).nullable(),
          injectionSite: z
            .string()
            .nullable()
            .describe("Recorded site, or null when none was captured."),
        }),
      )
      .describe(
        "The last twelve taken doses, newest first, for the site-rotation view.",
      ),
    inventory: glp1Inventory
      .nullable()
      .describe(
        "Null when the medication has neither containers nor a usable legacy ledger — an unknown supply, which is not zero supply.",
      ),
  })
  .meta({
    id: "Glp1DetailResponse",
    description:
      "The GLP-1 card's extras: titration history, recent injections with their sites, and the running supply math.",
  });

export const glp1InventoryEvent = z
  .object({
    id: z.string(),
    medicationId: z.string(),
    delta: z.number().int().describe("Positive added, negative consumed."),
    reason: z.string(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "Glp1InventoryEvent",
    description:
      "A row of the DEPRECATED running-sum inventory ledger. Register containers through the inventory endpoints instead; reads fall back to this ledger only while a medication has no containers at all.",
  });

// ── Per-medication ingest endpoint (`/api/medications/{id}/api-endpoint`) ──
//
// The one place in this module where a raw credential can leave the server,
// and it leaves EXACTLY once: on the PUT that mints it. The GET answers
// presence and a count and nothing else, and a re-enable of an already-enabled
// endpoint answers `token: null` rather than re-issuing — the plaintext is
// hashed at rest and cannot be recovered, so a lost token means minting a new
// one by disabling and enabling again.

export const medicationApiEndpointState = z
  .object({
    enabled: z
      .boolean()
      .describe("True when at least one live token carries this scope."),
    activeTokenCount: z
      .number()
      .int()
      .describe(
        "Live, unrevoked, unexpired tokens scoped to this medication. Normally 0 or 1.",
      ),
  })
  .meta({
    id: "MedicationApiEndpointState",
    description:
      "Presence only. No token, hash or prefix is on this wire — the stored value is an HMAC and there is no path back to the plaintext.",
  });

export const medicationApiEndpointEnabled = z
  .object({
    enabled: z.literal(true),
    activeTokenCount: z.number().int(),
    token: z
      .string()
      .nullable()
      .describe(
        "The raw `hlk_<64 hex>` token, and the ONLY time it is ever returned. Null when the endpoint was already enabled and nothing was minted — check `created` rather than inferring from this. Store it on receipt; it is hashed at rest and cannot be shown again.",
      ),
    created: z
      .boolean()
      .describe("True when this call minted a token, false when one existed."),
  })
  .meta({
    id: "MedicationApiEndpointEnabled",
    description:
      "The answer to enabling the endpoint. A fresh mint is 201 with the token; an already-enabled endpoint is 200 with `token: null` and `created: false`.",
  });

export const medicationApiEndpointDisabled = z
  .object({
    enabled: z.literal(false),
    revokedTokenCount: z
      .number()
      .int()
      .describe("How many live tokens this call revoked."),
  })
  .meta({
    id: "MedicationApiEndpointDisabled",
    description:
      "The answer to disabling. Note the asymmetry: this shape carries `revokedTokenCount` and NOT `activeTokenCount`, so a client decoding one shape for both PUT outcomes will find the key missing.",
  });

// ── Reminder phase config (`/api/medications/{id}/phase-config`) ──────

export const reminderPhaseConfig = z
  .object({
    id: z
      .string()
      .optional()
      .describe(
        "Row id. ABSENT when the read fell through to defaults, because no row exists — which is how a client tells a stored configuration from the fallback.",
      ),
    medicationId: z.string().optional().describe("Absent on the defaults."),
    greenValue: z.number().int(),
    greenMode: z.enum(["MINUTES", "PERCENT"]),
    yellowValue: z.number().int(),
    yellowMode: z.enum(["MINUTES", "PERCENT"]),
    orangeValue: z.number().int(),
    orangeMode: z.enum(["MINUTES", "PERCENT"]),
    redValue: z.number().int(),
    redMode: z.enum(["MINUTES", "PERCENT"]),
  })
  .meta({
    id: "ReminderPhaseConfig",
    description:
      "How long each reminder phase runs for one medication. `MINUTES` is an absolute offset; `PERCENT` is a share of the dose window. Values are 0..1440.",
  });

// ── Side effects (`/api/medications/{id}/side-effects`) ───────────────

export const medicationSideEffect = z
  .object({
    id: z.string(),
    userId: z
      .string()
      .describe(
        "The RECORD owner, which is not the actor on a delegated write.",
      ),
    medicationId: z.string(),
    occurredAt: z.iso.datetime({ offset: true }),
    category: z
      .string()
      .describe(
        "Derived SERVER-side from `entry` through the authoritative taxonomy. Never accepted from a client — a category sent on the wire is dropped, so a row cannot be stamped with one that contradicts its entry.",
      ),
    entry: z.string().describe("The catalogue entry. Closed Prisma enum."),
    severity: z.number().int().min(1).max(5),
    notes: z
      .string()
      .nullable()
      .describe(
        "The free-text note, decrypted on read. Stored encrypted; the ciphertext column is stripped before the row leaves the server.",
      ),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MedicationSideEffect",
    description:
      "One logged side effect. Not a clinical record — the account owns it, and it stays deletable at any time rather than locking after a retraction window.",
  });
