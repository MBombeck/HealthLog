/**
 * v1.5.4 — Medication wizard payload + pure helpers.
 *
 * The wizard is a popup that drives the same eight-step decision in
 * a "one question per breath" cadence. The pure helpers here
 * (state machine, validation gate, request body builder, summary
 * formatter) carry the test surface; the dialog and step components
 * compose them.
 *
 * Step encoding:
 *   1. Name (medication-global)
 *   2. Treatment class / clinical category (medication-global)
 *   3. Dose (medication-global)
 *   4. Course window (medication-global)
 *   5. Cadence (per-schedule)
 *   6. Sub-cadence detail (per-schedule, conditional)
 *   7. Times of day (per-schedule)
 *   8. Schedule list + reminders + summary (medication-global)
 *
 * The visible step counter follows the path the user actually walks
 * for the ACTIVE schedule:
 *
 *   ONE_SHOT_PATH  = [1, 2, 3, 4, 8]       — 5 steps
 *   DAILY_PATH     = [1, 2, 3, 4, 5, 7, 8] — 7 steps
 *   RECURRING_PATH = [1, 2, 3, 4, 5, 6, 7, 8] — 8 steps
 *
 * The mode is set in Step 5: "Einmalig" picks `oneShot`; every other
 * radio picks `recurring`. The cadence kind drives the path between
 * daily (skips Step 6) and the calendar-anchored / rolling shapes.
 *
 * Compose-mode: a medication can hold N parallel schedules. Steps 5-7
 * mutate the schedule at `activeScheduleIndex`; Step 8 surfaces the
 * full list with add / edit / remove actions. The flat
 * `(mode, cadence, subControls, timesOfDay)` fields on the payload
 * mirror the active draft so the step components stay
 * single-schedule-aware. The list-mutating helpers below keep that
 * mirror in sync.
 *
 * Each row in Step 2 maps to a `(treatmentClass, category)` pair that
 * the request body carries. GLP-1-Injektion is the only row that picks
 * `treatmentClass = "GLP1"`; every other row inherits `GENERIC` and
 * differs only on the clinical-category bucket the analytics layer
 * reads. The mapping table is the single source of truth.
 */

import { encodeCadence } from "@/components/medications/scheduling/cadence-picker";
import { dateToIsoString } from "@/components/medications/scheduling/course-window-row";
import {
  type CadenceKind,
  type CadenceSubControls,
  type CadenceValue,
  DEFAULT_SUB_CONTROLS,
} from "@/components/medications/scheduling/types";
import {
  inferCadenceFromLegacy,
  legacyPairFromCadence,
} from "@/components/medications/scheduling/legacy-bridge";
import {
  type MedicationTreatmentClass,
  type MedicationCategoryValue,
  type MedicationDeliveryForm,
} from "@/lib/validations/medication";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";
import {
  isExplicitRange,
  type DoseWindowEntry,
} from "@/components/medications/scheduling/dose-window";

// ────────────────────────────────────────────────────────────────────
// Step 2 — treatment-class taxonomy
// ────────────────────────────────────────────────────────────────────

/**
 * Step 2 row identifiers. Distinct from `MedicationCategoryValue` so a
 * single picker row can map onto the orthogonal `(treatmentClass,
 * category)` pair the schema persists.
 */
export type WizardTreatmentRow =
  | "bloodPressure"
  | "diabetes"
  | "hormone"
  | "glp1"
  | "painRelief"
  | "allergy"
  | "vitamin"
  | "supplement"
  | "antibiotic"
  | "other";

/**
 * The ten taxonomy rows in their visible order. maintainer-confirmed (D-1
 * §3 Step 2): Blutdruck · Diabetes · Hormone · GLP-1-Injektion ·
 * Schmerz · Allergie · Vitamine · Nahrungsergänzung · Antibiotikum ·
 * Sonstiges.
 */
export const WIZARD_TREATMENT_ROWS: readonly WizardTreatmentRow[] = [
  "bloodPressure",
  "diabetes",
  "hormone",
  "glp1",
  "painRelief",
  "allergy",
  "vitamin",
  "supplement",
  "antibiotic",
  "other",
];

/**
 * Mapping table: Step 2 row → `(treatmentClass, category)` pair the
 * request body carries. GLP-1 is the only row that bends the Prisma
 * treatment-class enum; every other row inherits `GENERIC`.
 */
export const WIZARD_TREATMENT_MAPPING: Record<
  WizardTreatmentRow,
  {
    treatmentClass: MedicationTreatmentClass;
    category: MedicationCategoryValue;
  }
> = {
  bloodPressure: { treatmentClass: "GENERIC", category: "BLOOD_PRESSURE" },
  diabetes: { treatmentClass: "GENERIC", category: "DIABETES" },
  hormone: { treatmentClass: "GENERIC", category: "HORMONE" },
  glp1: { treatmentClass: "GLP1", category: "OTHER" },
  painRelief: { treatmentClass: "GENERIC", category: "PAIN_RELIEF" },
  allergy: { treatmentClass: "GENERIC", category: "ALLERGY" },
  vitamin: { treatmentClass: "GENERIC", category: "VITAMIN" },
  supplement: { treatmentClass: "GENERIC", category: "SUPPLEMENT" },
  antibiotic: { treatmentClass: "GENERIC", category: "ANTIBIOTIC" },
  other: { treatmentClass: "GENERIC", category: "OTHER" },
};

/**
 * Reverse-map a `(treatmentClass, category)` pair onto the Step 2 row
 * the wizard pre-selects on edit. GLP-1 takes priority (a GLP-1
 * medication is a GLP-1 row regardless of the side-table value).
 * Unknown categories fall back to "other".
 */
export function rowFromTreatment(
  treatmentClass: string | undefined,
  category: string | undefined,
): WizardTreatmentRow {
  if (treatmentClass === "GLP1") return "glp1";
  switch (category) {
    case "BLOOD_PRESSURE":
      return "bloodPressure";
    case "DIABETES":
      return "diabetes";
    case "HORMONE":
      return "hormone";
    case "PAIN_RELIEF":
      return "painRelief";
    case "ALLERGY":
      return "allergy";
    case "VITAMIN":
      return "vitamin";
    case "SUPPLEMENT":
      return "supplement";
    case "ANTIBIOTIC":
      return "antibiotic";
    default:
      return "other";
  }
}

// ────────────────────────────────────────────────────────────────────
// Wizard payload + per-schedule draft
// ────────────────────────────────────────────────────────────────────

/**
 * One schedule under construction inside the wizard. A medication can
 * hold N parallel drafts (e.g. short-acting insulin to meals + a
 * long-acting evening dose on the same medication). The `id` is
 * present on edit hydrate so the round-trip preserves identity for
 * the API layer; create drafts leave it undefined.
 */
export interface ScheduleDraft {
  id?: string;
  mode: "oneShot" | "recurring" | "asNeeded" | null;
  cadence: CadenceValue;
  subControls: CadenceSubControls;
  timesOfDay: string[];
  /**
   * #219 — per-schedule dose override (empty = inherit the medication
   * `dose`). Lets a "1-0.5-0.5" split ride ONE medication with three
   * schedules at different doses instead of three separate drugs.
   */
  dose?: string;
  /**
   * #219 — per-schedule units-consumed-per-dose (empty = inherit the
   * medication `unitsPerDose`). Decrements the right tablet count for a
   * morning-whole / noon-half plan.
   */
  unitsPerDose?: string;
  /**
   * v1.15.18 — per-dose explicit on-time windows. One entry per dose
   * time the user widened beyond the symmetric ±1h default; a time with
   * no entry keeps the default band. Empty when every dose uses the
   * default (the wire then omits / sends `[]`, leaving the column NULL).
   */
  doseWindows?: DoseWindowEntry[];
}

/**
 * The wizard's working state. The cadence + sub-controls mirror the
 * picker primitives; the treatment row collapses Step 2's
 * `(treatmentClass, category)` decision into a single value the
 * mapping table re-expands at submit time.
 *
 * Steps 1-4 + 8 are medication-global. Steps 5-7 edit the schedule
 * at `activeScheduleIndex`. The flat `(mode, cadence, subControls,
 * timesOfDay)` fields mirror the active draft so the step components
 * stay single-schedule-aware; the list-mutating helpers below keep
 * the mirror in sync.
 */
export interface WizardPayload {
  name: string;
  doseAmount: string;
  doseUnit: string;
  treatmentRow: WizardTreatmentRow | null;
  /**
   * v1.6.0 — route of administration. Drives the injection-site
   * rotation preview (shown when `INJECTION`) and, paired with
   * `mode === "oneShot"`, the one-time-injection shape. Defaults to
   * `ORAL`; the GLP-1 treatment row nudges it to `INJECTION` on
   * selection so the common case needs no extra tap.
   */
  deliveryForm: MedicationDeliveryForm;
  /**
   * v1.6.0 — doses per pen / vial for inventory math. Empty string =
   * inventory tracking off (maps to `undefined` / NULL on the wire).
   */
  dosesPerUnit: string;
  /**
   * v1.16.10 — inventory units one dose consumes (2 × 2 mg tablets for
   * a 4 mg dose). Empty string / "1" both map to the server default 1.
   */
  unitsPerDose: string;
  /**
   * v1.8.5 — per-medication injection-site tracking opt-in. Only
   * surfaced in Step 3 when `deliveryForm === "INJECTION"`. Default
   * false (opt-in). Toggling it off clears `allowedInjectionSites`.
   */
  trackInjectionSites: boolean;
  /**
   * v1.8.5 — per-medication allowed / preferred injection sites. Empty =
   * no restriction (every site offered). Only meaningful when
   * `trackInjectionSites` is true.
   */
  allowedInjectionSites: InjectionSiteKey[];
  /** Set in Step 5 — mirrors `schedules[activeScheduleIndex].mode`. */
  mode: "oneShot" | "recurring" | "asNeeded" | null;
  /** Mirrors `schedules[activeScheduleIndex].cadence`. */
  cadence: CadenceValue;
  /** Mirrors `schedules[activeScheduleIndex].subControls`. */
  subControls: CadenceSubControls;
  /** Mirrors `schedules[activeScheduleIndex].timesOfDay`. */
  timesOfDay: string[];
  /**
   * #219 — mirrors `schedules[activeScheduleIndex].dose`. The per-slot
   * dose + units inputs on Step 7 read + write these flat slots; the
   * active-draft helpers keep them in sync with the schedule list. Empty
   * string = inherit the medication-level value.
   */
  scheduleDose: string;
  /** #219 — mirrors `schedules[activeScheduleIndex].unitsPerDose`. */
  scheduleUnitsPerDose: string;
  /**
   * v1.15.18 — mirrors `schedules[activeScheduleIndex].doseWindows`. The
   * per-dose window editor in Step 7 reads + writes this flat slot; the
   * active-draft helpers keep it in sync with the schedule list.
   */
  doseWindows: DoseWindowEntry[];
  startsOn: Date | null;
  endsOn: Date | null;
  notificationsEnabled: boolean;
  /**
   * v1.39.1 (#1033) — intake tracking. Off keeps the medication, dose and
   * schedule as a record: nothing due, no reminders, no adherence.
   */
  trackIntake: boolean;
  /** Every parallel schedule under construction. Always >= 1 entry. */
  schedules: ScheduleDraft[];
  /** Which schedule Steps 5-7 currently edit. */
  activeScheduleIndex: number;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0),
  );
}

/** Default draft for a fresh schedule slot. */
export function emptyScheduleDraft(): ScheduleDraft {
  return {
    mode: null,
    cadence: encodeCadence("daily", DEFAULT_SUB_CONTROLS),
    subControls: { ...DEFAULT_SUB_CONTROLS },
    timesOfDay: ["08:00"],
  };
}

/** Sensible defaults for a fresh wizard. */
export function emptyWizardPayload(): WizardPayload {
  const draft = emptyScheduleDraft();
  return {
    name: "",
    doseAmount: "",
    doseUnit: "mg",
    treatmentRow: null,
    deliveryForm: "ORAL",
    dosesPerUnit: "",
    unitsPerDose: "1",
    trackInjectionSites: false,
    allowedInjectionSites: [],
    mode: draft.mode,
    cadence: draft.cadence,
    subControls: draft.subControls,
    timesOfDay: draft.timesOfDay,
    scheduleDose: draft.dose ?? "",
    scheduleUnitsPerDose: draft.unitsPerDose ?? "",
    doseWindows: draft.doseWindows ?? [],
    startsOn: todayUtc(),
    endsOn: null,
    notificationsEnabled: true,
    trackIntake: true,
    schedules: [draft],
    activeScheduleIndex: 0,
  };
}

// ────────────────────────────────────────────────────────────────────
// Active-draft mirror helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Project the flat per-schedule fields onto the schedule slot at
 * `activeScheduleIndex`. Pure — returns a new payload with the
 * updated schedules array.
 */
export function commitActiveDraft(payload: WizardPayload): WizardPayload {
  const idx = payload.activeScheduleIndex;
  if (idx < 0 || idx >= payload.schedules.length) return payload;
  const current = payload.schedules[idx];
  const next: ScheduleDraft = {
    ...current,
    mode: payload.mode,
    cadence: payload.cadence,
    subControls: payload.subControls,
    timesOfDay: payload.timesOfDay,
    // #219 — project the per-slot dose / units flat mirror onto the draft.
    // Empty string collapses to undefined so the encode path omits the
    // field and the schedule inherits the medication-level value.
    dose: payload.scheduleDose.trim() === "" ? undefined : payload.scheduleDose,
    unitsPerDose:
      payload.scheduleUnitsPerDose.trim() === ""
        ? undefined
        : payload.scheduleUnitsPerDose,
    doseWindows: payload.doseWindows,
  };
  const schedules = payload.schedules.slice();
  schedules[idx] = next;
  return { ...payload, schedules };
}

/**
 * Pull the schedule slot at `index` onto the flat mirror fields and
 * set `activeScheduleIndex`. Used when Step 8 routes the user into a
 * Bearbeiten action.
 */
export function setActiveSchedule(
  payload: WizardPayload,
  index: number,
): WizardPayload {
  if (index < 0 || index >= payload.schedules.length) return payload;
  const draft = payload.schedules[index];
  return {
    ...payload,
    activeScheduleIndex: index,
    mode: draft.mode,
    cadence: draft.cadence,
    subControls: draft.subControls,
    timesOfDay: draft.timesOfDay,
    scheduleDose: draft.dose ?? "",
    scheduleUnitsPerDose: draft.unitsPerDose ?? "",
    doseWindows: draft.doseWindows ?? [],
  };
}

/**
 * Append a fresh empty schedule to the list, commit the currently
 * active draft so its in-flight edits are not lost, and land the
 * active pointer on the new slot.
 */
export function addSchedule(payload: WizardPayload): WizardPayload {
  const committed = commitActiveDraft(payload);
  const draft = emptyScheduleDraft();
  const schedules = [...committed.schedules, draft];
  return {
    ...committed,
    schedules,
    activeScheduleIndex: schedules.length - 1,
    mode: draft.mode,
    cadence: draft.cadence,
    subControls: draft.subControls,
    timesOfDay: draft.timesOfDay,
    scheduleDose: draft.dose ?? "",
    scheduleUnitsPerDose: draft.unitsPerDose ?? "",
  };
}

/**
 * Remove the schedule at `index`. Refuses when only one schedule
 * remains — a medication must carry at least one. The active pointer
 * clamps into the new list bounds and the flat mirror re-syncs.
 */
export function removeSchedule(
  payload: WizardPayload,
  index: number,
): WizardPayload {
  if (payload.schedules.length <= 1) return payload;
  if (index < 0 || index >= payload.schedules.length) return payload;
  const schedules = payload.schedules.filter((_, i) => i !== index);
  const nextIndex = Math.min(payload.activeScheduleIndex, schedules.length - 1);
  const draft = schedules[nextIndex];
  return {
    ...payload,
    schedules,
    activeScheduleIndex: nextIndex,
    mode: draft.mode,
    cadence: draft.cadence,
    subControls: draft.subControls,
    timesOfDay: draft.timesOfDay,
    scheduleDose: draft.dose ?? "",
    scheduleUnitsPerDose: draft.unitsPerDose ?? "",
  };
}

// ────────────────────────────────────────────────────────────────────
// Path table — visible step counter
// ────────────────────────────────────────────────────────────────────

const ONE_SHOT_PATH: readonly number[] = [1, 2, 3, 4, 8];
/**
 * v1.16.11 — as-needed (PRN) walks the one-shot shape: picking
 * "Bei Bedarf" in Step 5 skips the sub-cadence + times steps entirely
 * (an as-needed medication carries no schedule), landing on the
 * summary. The dose step stays — dose text + unitsPerDose still feed
 * inventory consumption.
 */
const AS_NEEDED_PATH: readonly number[] = [1, 2, 3, 4, 8];
const DAILY_PATH: readonly number[] = [1, 2, 3, 4, 5, 7, 8];
const RECURRING_PATH: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * The ordered list of raw step numbers for the active mode + cadence.
 * Mirrors v1.5.3's `progressIndices` shape so the visible counter
 * tracks the path the user actually walks.
 *
 * The mode is set in Step 5. Before that, the wizard renders the
 * recurring path so the displayed counter stays monotone.
 */
export function progressIndices(
  mode: WizardPayload["mode"],
  cadenceKind: CadenceKind,
): readonly number[] {
  if (mode === "oneShot") return ONE_SHOT_PATH;
  if (mode === "asNeeded") return AS_NEEDED_PATH;
  if (mode === "recurring" && cadenceKind === "daily") return DAILY_PATH;
  return RECURRING_PATH;
}

// ────────────────────────────────────────────────────────────────────
// validateStep — pure per-step gate
// ────────────────────────────────────────────────────────────────────

/**
 * Returns true when the step's required inputs are populated.
 *
 * Matrix:
 *  - Step 1: name populated.
 *  - Step 2: treatment row picked.
 *  - Step 3: doseAmount populated.
 *  - Step 4: startsOn present + (endsOn null OR endsOn >= startsOn).
 *  - Step 5: mode picked.
 *  - Step 6: cadence-specific (weekdays >= 1; interval >= 1; monthly
 *    day 1..31; rolling 1..365).
 *  - Step 7: >= 1 valid HH:mm time.
 *  - Step 8: mirrors Step 4 (the reminders toggle has no failure mode).
 */
export function validateStep(payload: WizardPayload, step: number): boolean {
  switch (step) {
    case 1:
      return payload.name.trim().length > 0;
    case 2:
      return payload.treatmentRow !== null;
    case 3:
      return payload.doseAmount.trim().length > 0;
    case 4:
      if (payload.startsOn === null) return false;
      if (payload.endsOn === null) return true;
      return payload.endsOn.getTime() >= payload.startsOn.getTime();
    case 5:
      return payload.mode !== null;
    case 6: {
      if (payload.mode !== "recurring") return true;
      switch (payload.cadence.kind) {
        case "weekdays":
          return payload.subControls.weekdays.length >= 1;
        case "everyNWeeks":
          return (
            payload.subControls.weekdays.length >= 1 &&
            payload.subControls.intervalWeeks >= 1
          );
        case "monthly":
          return (
            payload.subControls.dayOfMonth >= 1 &&
            payload.subControls.dayOfMonth <= 31
          );
        case "rolling":
          return (
            payload.subControls.rollingDays >= 1 &&
            payload.subControls.rollingDays <= 365
          );
        default:
          return true;
      }
    }
    case 7: {
      const times = payload.timesOfDay.filter((t) => TIME_RE.test(t));
      return times.length >= 1;
    }
    case 8:
      if (payload.startsOn === null) return false;
      if (payload.endsOn === null) return true;
      return payload.endsOn.getTime() >= payload.startsOn.getTime();
    default:
      return false;
  }
}

// ────────────────────────────────────────────────────────────────────
// firstInvalidIndex — multi-step forward lookahead
// ────────────────────────────────────────────────────────────────────

/**
 * Walks `stepList` from `fromIndex` (inclusive) and returns the index of
 * the first slot whose `validateStep` gate fails, or `stepList.length`
 * when every slot from `fromIndex` onward validates.
 *
 * This generalises the single-step `canContinue` gate
 * (`validateStep(payload, step)`) into the forward-jump lookahead the
 * dot stepper uses: a forward jump to path-index `j` is allowed iff
 * `firstInvalidIndex(payload, stepList, i) >= j` — i.e. every gate
 * between the current slot `i` and the target `j` passes. The dot
 * stepper reuses the same value as its `reachableUntil` ceiling so the
 * gate and the visual reachability never drift.
 *
 * Pure: reuses `validateStep` verbatim, no new validation logic.
 */
export function firstInvalidIndex(
  payload: WizardPayload,
  stepList: readonly number[],
  fromIndex: number,
): number {
  for (let k = Math.max(0, fromIndex); k < stepList.length; k++) {
    if (!validateStep(payload, stepList[k])) return k;
  }
  return stepList.length;
}

// ────────────────────────────────────────────────────────────────────
// buildCreateBody — POST /api/medications request body
// ────────────────────────────────────────────────────────────────────

export interface CreateMedicationBody {
  name: string;
  dose: string;
  category: MedicationCategoryValue;
  treatmentClass: MedicationTreatmentClass;
  /** v1.6.0 — route of administration (ORAL | INJECTION | OTHER). */
  deliveryForm: MedicationDeliveryForm;
  /** v1.6.0 — doses per pen / vial. Omitted when inventory is off. */
  dosesPerUnit?: number;
  /** v1.16.10 — inventory units per dose. Omitted at the default 1. */
  unitsPerDose?: number;
  /** v1.8.5 — injection-site tracking opt-in. Omitted for non-injections. */
  trackInjectionSites?: boolean;
  /** v1.8.5 — per-medication allowed sites. Omitted when tracking is off. */
  allowedInjectionSites?: InjectionSiteKey[];
  /**
   * v1.5.5 D-3 §10 invariant 16 — the wizard owns the create-time
   * default for `notificationsEnabled` but never overwrites it on
   * edit. The detail page's notifications switch is the single source
   * of truth post-create; the wizard PUT body omits the field so a
   * user-toggled value never round-trips back to the wizard default.
   * `buildCreateBody(payload, "edit")` returns `undefined` here.
   */
  notificationsEnabled?: boolean;
  startsOn?: string;
  endsOn?: string;
  oneShot: boolean;
  /**
   * v1.16.11 (#316) — as-needed (PRN) medication. True emits an EMPTY
   * `schedules` array (the route 422s on any entry alongside the flag).
   */
  asNeeded: boolean;
  /**
   * v1.39.1 (#1033) — intake tracking, sent on every create and edit (the
   * wizard hydrates it from the stored value). An as-needed medication
   * always tracks intake.
   */
  trackIntake: boolean;
  schedules: Array<{
    id?: string;
    windowStart: string;
    windowEnd: string;
    timesOfDay: string[];
    rrule?: string;
    rollingIntervalDays?: number;
    daysOfWeek?: number[];
    intervalWeeks?: number;
    /** #219 — per-schedule dose override. Omitted = inherit `dose`. */
    dose?: string;
    /** #219 — per-schedule units per dose. Omitted = inherit `unitsPerDose`. */
    unitsPerDose?: number;
    /**
     * #219 — schedule type. PRN routes a per-draft as-needed slot onto the
     * SAME medication (an as-needed extra dose alongside scheduled ones)
     * instead of flipping the whole-medication `asNeeded` flag. Omitted =
     * SCHEDULED.
     */
    scheduleType?: "SCHEDULED" | "PRN";
    /** v1.15.18 — per-dose explicit on-time windows. Omitted when none. */
    doseWindows?: DoseWindowEntry[];
  }>;
}

function composeDose(amount: string, unit: string): string {
  const a = amount.trim();
  const u = unit.trim();
  if (!a) return u;
  if (!u) return a;
  return `${a} ${u}`;
}

function sortTimes(times: string[]): string[] {
  return [...times]
    .filter((t) => TIME_RE.test(t))
    .sort((a, b) => a.localeCompare(b));
}

function deriveWindow(sortedTimes: string[]): [string, string] {
  if (sortedTimes.length === 0) return ["08:00", "09:00"];
  const start = sortedTimes[0];
  if (sortedTimes.length === 1) return [start, addOneHour(start)];
  return [start, sortedTimes[sortedTimes.length - 1]];
}

function addOneHour(hhmm: string): string {
  const m = TIME_RE.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const mm = m[2];
  const next = (h + 1) % 24;
  return `${String(next).padStart(2, "0")}:${mm}`;
}

/**
 * Encode a single `ScheduleDraft` into the request-body schedule
 * entry. Mirrors the legacy bridge so each schedule dual-writes
 * `(daysOfWeek, intervalWeeks, rrule, rollingIntervalDays,
 * timesOfDay)` correctly. The `oneShotMedication` flag suppresses
 * recurrence on every schedule — the route enforces the
 * one-schedule-per-one-shot invariant on top.
 */
export function encodeScheduleDraft(
  draft: ScheduleDraft,
  oneShotMedication: boolean,
): CreateMedicationBody["schedules"][number] {
  const isOneShot = oneShotMedication || draft.mode === "oneShot";
  // #219 — a per-draft as-needed slot rides the SAME medication as a PRN
  // schedule (never due / reminded / scored), so an as-needed extra dose
  // sits alongside the scheduled ones instead of splitting into a second
  // drug. A PRN slot carries no cadence.
  const isPrn = draft.mode === "asNeeded";
  const times = sortTimes(
    isOneShot ? draft.timesOfDay.slice(0, 1) : draft.timesOfDay,
  );
  const [windowStart, windowEnd] = deriveWindow(times);
  const legacyPair = legacyPairFromCadence(draft.cadence, draft.subControls);

  const out: CreateMedicationBody["schedules"][number] = {
    windowStart,
    windowEnd,
    timesOfDay: times,
  };
  if (draft.id) out.id = draft.id;
  // #219 — per-slot dose + units overrides. Empty / whitespace collapses to
  // omitted so the schedule inherits the medication-level value.
  if (draft.dose && draft.dose.trim() !== "") out.dose = draft.dose.trim();
  if (draft.unitsPerDose && draft.unitsPerDose.trim() !== "") {
    const parsed = Number.parseFloat(draft.unitsPerDose);
    if (Number.isFinite(parsed) && parsed > 0) out.unitsPerDose = parsed;
  }
  if (isPrn) out.scheduleType = "PRN";
  // v1.15.18 — emit only the explicit windows that still name a live dose
  // time and actually differ from the default ±1h band (a point-equivalent
  // window leaves the column on the default derivation).
  if (draft.doseWindows && draft.doseWindows.length > 0) {
    const liveTimes = new Set(times);
    const windows = draft.doseWindows.filter(
      (w) => liveTimes.has(w.timeOfDay) && isExplicitRange(w),
    );
    if (windows.length > 0) out.doseWindows = windows;
  }
  // #219 — a PRN slot carries no cadence (the schedule validator rejects a
  // PRN with rrule / rollingIntervalDays), so suppress the recurrence block
  // exactly as the one-shot path does.
  if (!isOneShot && !isPrn) {
    if (draft.cadence.rrule !== null) {
      out.rrule = draft.cadence.rrule;
    } else if (draft.cadence.rollingIntervalDays !== null) {
      out.rollingIntervalDays = draft.cadence.rollingIntervalDays;
    }
    if (legacyPair.daysOfWeek.length > 0) {
      out.daysOfWeek = legacyPair.daysOfWeek;
    }
    out.intervalWeeks = legacyPair.intervalWeeks;
  }
  return out;
}

/**
 * Map a wizard payload onto the `POST /api/medications` body. The
 * route still requires the legacy `windowStart` / `windowEnd` pair for
 * the v1.5.x dual-write window; we derive them from the times.
 *
 * The treatment row drives both `treatmentClass` and `category` through
 * the mapping table. The route writes `category` to the side-table.
 *
 * Compose-mode: every entry in `payload.schedules` lands in the body's
 * `schedules` array. The active draft is committed first so any
 * in-flight edits flow into the encoded entry.
 *
 * For one-shot medications the wizard collapses to a single schedule;
 * recurrence fields are suppressed across the board and the route
 * normalises `endsOn` to equal `startsOn`.
 */
export function buildCreateBody(
  payload: WizardPayload,
  forMode: "create" | "edit" = "create",
): CreateMedicationBody {
  const committed = commitActiveDraft(payload);
  const dose = composeDose(committed.doseAmount, committed.doseUnit);
  const mapping =
    committed.treatmentRow !== null
      ? WIZARD_TREATMENT_MAPPING[committed.treatmentRow]
      : WIZARD_TREATMENT_MAPPING.other;

  // A one-shot medication carries exactly one schedule with no
  // recurrence. We honour the active draft (it carries the times the
  // user picked); the route enforces the one-schedule invariant.
  // v1.16.11 — an as-needed medication carries NO schedule at all; the
  // wizard clears the list client-side (the server 422s otherwise).
  const isOneShot = committed.mode === "oneShot";
  // #219 — an as-needed slot only flips the WHOLE-medication asNeeded flag
  // (zero schedules, never due / scored) when EVERY draft is as-needed. When
  // an as-needed draft sits alongside scheduled ones it is emitted as a PRN
  // schedule on the same medication (see `encodeScheduleDraft`), so a
  // scheduled plan can carry an as-needed extra dose without a second drug.
  const hasScheduledDraft = committed.schedules.some(
    (d) => d.mode !== "asNeeded",
  );
  const isAsNeeded = !isOneShot && !hasScheduledDraft;
  const draftsToEmit = isAsNeeded
    ? []
    : isOneShot
      ? [
          committed.schedules[committed.activeScheduleIndex] ??
            committed.schedules[0],
        ]
      : committed.schedules;

  const parsedDosesPerUnit = Number.parseInt(committed.dosesPerUnit, 10);
  // v1.16.12 — fractional dosing: parse as a float (½ → 0.5) and gate at
  // > 0, not the old integer `>= 1`, so a split-pill dose survives.
  const parsedUnitsPerDose = Number.parseFloat(committed.unitsPerDose);
  const body: CreateMedicationBody = {
    name: committed.name.trim(),
    dose,
    category: mapping.category,
    treatmentClass: mapping.treatmentClass,
    deliveryForm: committed.deliveryForm,
    ...(Number.isFinite(parsedDosesPerUnit) &&
      parsedDosesPerUnit >= 1 && {
        dosesPerUnit: parsedDosesPerUnit,
      }),
    // v1.16.10 — always sent when valid (an edit back to 1 must reach
    // the server; the create default matches the schema default).
    ...(Number.isFinite(parsedUnitsPerDose) &&
      parsedUnitsPerDose > 0 && {
        unitsPerDose: parsedUnitsPerDose,
      }),
    // v1.8.5 — injection-site tracking is only meaningful for an
    // INJECTION delivery form. Always send the boolean for an injection
    // (so edits can deactivate it); send the allowed list only when
    // tracking is on. Non-injections omit both (server keeps defaults).
    ...(committed.deliveryForm === "INJECTION" && {
      trackInjectionSites: committed.trackInjectionSites,
      ...(committed.trackInjectionSites && {
        allowedInjectionSites: committed.allowedInjectionSites,
      }),
    }),
    // v1.5.5 D-3 §10 invariant 16 — `notificationsEnabled` only on
    // create. Edits never round-trip the wizard's default because the
    // detail page's notifications switch is the single source of
    // truth post-create.
    ...(forMode === "create" && {
      notificationsEnabled: committed.notificationsEnabled,
    }),
    oneShot: isOneShot,
    asNeeded: isAsNeeded,
    // Always named, so the server applies this schedule even to a
    // medication kept as a record. Turning a medication into an as-needed
    // one means doses will be logged, so it tracks intake again.
    trackIntake: isAsNeeded ? true : committed.trackIntake,
    schedules: draftsToEmit.map((draft) =>
      encodeScheduleDraft(draft, isOneShot),
    ),
  };
  if (committed.startsOn) {
    body.startsOn = dateToIsoString(committed.startsOn);
  }
  if (isOneShot && committed.startsOn) {
    body.endsOn = dateToIsoString(committed.startsOn);
  } else if (committed.endsOn) {
    body.endsOn = dateToIsoString(committed.endsOn);
  }
  return body;
}

// ────────────────────────────────────────────────────────────────────
// summariseCadence — plain-language Step 8 line
// ────────────────────────────────────────────────────────────────────

function summaryKeyForDraft(
  mode: WizardPayload["mode"],
  cadence: CadenceValue,
  sub: CadenceSubControls,
): string {
  if (mode === "oneShot") return "oneShot";
  if (mode === "asNeeded") return "asNeeded";
  switch (cadence.kind) {
    case "daily":
      return "daily";
    case "weekdays":
      return "weekdays";
    case "everyNWeeks":
      return sub.intervalWeeks === 2 ? "biweekly" : "everyNWeeks";
    case "monthly":
      return "monthly";
    case "everyNMonths":
      return sub.intervalMonths === 3 ? "quarterly" : "everyNMonths";
    case "yearly":
      return "yearly";
    case "rolling":
      return "rolling";
    case "oneShot":
      return "oneShot";
  }
}

function weekdaysDetail(
  tokens: readonly string[],
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (tokens.length === 0) return "";
  const names = tokens
    .map((tok) =>
      t(`medications.scheduling.cadence.weekdays.long.${tok.toLowerCase()}`),
    )
    .filter(Boolean);
  if (names.length === 0) return "";
  return t("medications.wizard.summary.weekdaysDetail", {
    days: names.join(", "),
  });
}

/**
 * The cadence-bearing slice both {@link WizardPayload} and
 * {@link ScheduleDraft} share. Summary helpers only ever read these three
 * fields, so the cadence-line builder below stays draft/payload-agnostic.
 */
type CadenceShape = Pick<ScheduleDraft, "mode" | "cadence" | "subControls">;

/**
 * The interpolation count the cadence summary keys read. `everyNWeeks`
 * surfaces the week interval; `rolling` the day interval; everything else
 * leaves it at zero. Extracted so the medication-wide and per-schedule
 * summaries can't drift apart.
 */
function cadenceInterpolationN(shape: CadenceShape): number {
  if (shape.cadence.kind === "everyNWeeks")
    return shape.subControls.intervalWeeks;
  if (shape.cadence.kind === "rolling")
    return shape.cadence.rollingIntervalDays ?? 0;
  return 0;
}

/**
 * The trailing detail clause appended to a cadence phrase (the weekday
 * list or the day-of-month). Empty for one-shot doses and for cadences
 * that carry no extra detail.
 */
function cadenceDetailPhrase(
  shape: CadenceShape,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (shape.mode === "oneShot") return "";
  switch (shape.cadence.kind) {
    case "weekdays":
      return weekdaysDetail(shape.subControls.weekdays, t);
    case "everyNWeeks":
      return weekdaysDetail(shape.subControls.weekdays, t);
    case "monthly":
      return t("medications.wizard.summary.dayOfMonthDetail", {
        day: shape.subControls.dayOfMonth,
      });
    default:
      return "";
  }
}

/**
 * The full cadence line — phrase (`every N weeks`, `daily`, …) plus its
 * detail clause. Both {@link summariseCadence} and
 * {@link summariseScheduleDraft} build their first segment from this so
 * the two summaries render byte-identical cadence text.
 */
function cadenceLineFor(
  shape: CadenceShape,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const cadenceKey = summaryKeyForDraft(
    shape.mode,
    shape.cadence,
    shape.subControls,
  );
  const cadencePhrase = t(`medications.wizard.summary.cadence.${cadenceKey}`, {
    n: cadenceInterpolationN(shape),
  });
  return cadencePhrase + cadenceDetailPhrase(shape, t);
}

/**
 * Plain-language summary for Step 8. Mirrors v1.5.3's helper shape so
 * the test surface stays familiar. The `t` callback is passed in so
 * the helper stays pure (no React hook coupling).
 */
export function summariseCadence(
  payload: WizardPayload,
  t: (key: string, params?: Record<string, string | number>) => string,
  // v1.16.4 — UI callers pass `useFormatters().date` so the course-window
  // dates render in the active locale ("11.06.2026" / "Jun 11, 2026")
  // instead of the raw ISO string. The ISO default keeps the helper pure
  // for non-React callers.
  formatDate: (d: Date) => string = dateToIsoString,
): string {
  const cadenceLine = cadenceLineFor(payload, t);
  const timesPhrase =
    payload.mode !== "oneShot" &&
    payload.mode !== "asNeeded" &&
    payload.timesOfDay.length > 0
      ? t("medications.wizard.summary.times", {
          times: sortTimes(payload.timesOfDay).join(", "),
        })
      : "";
  const startPhrase = payload.startsOn
    ? t("medications.wizard.summary.startsOn", {
        date: formatDate(payload.startsOn),
      })
    : "";
  const endPhrase =
    payload.mode === "oneShot"
      ? ""
      : payload.endsOn
        ? t("medications.wizard.summary.endsOn", {
            date: formatDate(payload.endsOn),
          })
        : t("medications.wizard.summary.noEndDate");
  return [cadenceLine, timesPhrase, startPhrase, endPhrase]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Per-schedule summary the Step 8 list cards render. Skips the
 * course-window phrases (those are medication-global and only need to
 * render once on the summary block at the top of Step 8).
 */
export function summariseScheduleDraft(
  draft: ScheduleDraft,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const cadenceLine = cadenceLineFor(draft, t);
  const timesPhrase =
    draft.mode !== "oneShot" &&
    draft.mode !== "asNeeded" &&
    draft.timesOfDay.length > 0
      ? t("medications.wizard.summary.times", {
          times: sortTimes(draft.timesOfDay).join(", "),
        })
      : "";
  return [cadenceLine, timesPhrase].filter(Boolean).join(" · ");
}

// ────────────────────────────────────────────────────────────────────
// Hydration — edit-path payload from an existing medication
// ────────────────────────────────────────────────────────────────────

/**
 * Snapshot of a medication's persisted state, as the list page passes
 * it to `<MedicationWizardDialog mode="edit">`. Schedules carry both
 * the v1.5 cadence fields and the legacy `(daysOfWeek, intervalWeeks)`
 * pair so the bridge can hydrate older medications cleanly.
 */
export interface MedicationPayload {
  id: string;
  name: string;
  dose: string;
  category: string;
  treatmentClass?: string;
  /** v1.6.0 — route of administration. Defaults to ORAL when absent. */
  deliveryForm?: string;
  /** v1.6.0 — doses per pen / vial. NULL = inventory tracking off. */
  dosesPerUnit?: number | null;
  /** v1.16.10 — inventory units per dose (default 1). */
  unitsPerDose?: number | null;
  /** v1.8.5 — injection-site tracking opt-in. */
  trackInjectionSites?: boolean;
  /** v1.8.5 — per-medication allowed / preferred injection sites. */
  allowedInjectionSites?: string[];
  notificationsEnabled: boolean;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  /** v1.16.11 — as-needed (PRN) flag; hydrates the "Bei Bedarf" mode. */
  asNeeded?: boolean;
  /** v1.39.1 (#1033) — intake tracking; absent = tracked. */
  trackIntake?: boolean;
  schedules: Array<{
    id?: string;
    windowStart: string;
    windowEnd: string;
    label?: string | null;
    dose?: string | null;
    /** #219 — per-schedule units per dose (edit-hydrate). NULL = inherit. */
    unitsPerDose?: number | null;
    daysOfWeek?: number[];
    intervalWeeks?: number;
    timesOfDay?: string[];
    rrule?: string | null;
    rollingIntervalDays?: number | null;
    /** #219 — per-schedule as-needed slot (PRN) round-trips as a mode. */
    scheduleType?: string | null;
    /** v1.15.18 — per-dose explicit on-time windows (edit-hydrate). */
    doseWindows?: DoseWindowEntry[] | null;
  }>;
}

/** Coerce a persisted `deliveryForm` string onto the closed enum. */
function normaliseDeliveryForm(
  value: string | undefined,
): MedicationDeliveryForm {
  return value === "INJECTION" || value === "OTHER" ? value : "ORAL";
}

const DOSE_EXPR_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(.*)$/;

/** Try to split "5 mg" into ["5", "mg"]; falls back to ["", input]. */
function parseDoseExpression(input: string): { amount: string; unit: string } {
  const match = DOSE_EXPR_RE.exec(input.trim());
  if (!match) return { amount: "", unit: input.trim() };
  const amount = match[1] ?? "";
  const unit = (match[2] ?? "").trim();
  return { amount, unit };
}

interface MedicationScheduleSnapshot {
  id?: string;
  windowStart: string;
  windowEnd: string;
  dose?: string | null;
  unitsPerDose?: number | null;
  scheduleType?: string | null;
  daysOfWeek?: number[];
  intervalWeeks?: number;
  timesOfDay?: string[];
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  doseWindows?: DoseWindowEntry[] | null;
}

function hydrateScheduleDraft(
  schedule: MedicationScheduleSnapshot,
  oneShot: boolean,
): ScheduleDraft {
  const cadence = deriveCadenceFromSchedule(schedule, oneShot);
  const times =
    schedule.timesOfDay && schedule.timesOfDay.length > 0
      ? [...schedule.timesOfDay]
      : schedule.windowStart
        ? [schedule.windowStart]
        : ["08:00"];
  // #219 — a PRN schedule round-trips as an as-needed draft; every other
  // type hydrates as recurring (one-shot is driven by the medication flag).
  const isPrn = !oneShot && schedule.scheduleType === "PRN";
  const draft: ScheduleDraft = {
    mode: oneShot ? "oneShot" : isPrn ? "asNeeded" : "recurring",
    cadence: cadence.value,
    subControls: cadence.subControls,
    timesOfDay: times,
  };
  if (schedule.id) draft.id = schedule.id;
  // #219 — round-trip the per-slot dose + units so an edit keeps the split.
  if (typeof schedule.dose === "string" && schedule.dose.trim() !== "") {
    draft.dose = schedule.dose;
  }
  if (typeof schedule.unitsPerDose === "number" && schedule.unitsPerDose > 0) {
    draft.unitsPerDose = String(schedule.unitsPerDose);
  }
  // v1.15.18 — round-trip the persisted per-dose windows so an edit keeps
  // the user's explicit ranges instead of resetting them to the default.
  if (schedule.doseWindows && schedule.doseWindows.length > 0) {
    draft.doseWindows = schedule.doseWindows;
  }
  return draft;
}

/**
 * Hydrate a `WizardPayload` from a medication snapshot. Every schedule
 * on the snapshot lands as its own `ScheduleDraft` so compose-mode
 * surfaces the full list on the edit path. The flat mirror points at
 * the first draft so the step components stay coherent.
 *
 * The legacy bridge (`inferCadenceFromLegacy`) infers a cadence from
 * the `(daysOfWeek, intervalWeeks)` pair when the v1.5 `rrule` /
 * `rollingIntervalDays` fields are absent.
 */
export function hydrateWizardPayload(
  initial: MedicationPayload,
): WizardPayload {
  const base = emptyWizardPayload();
  const parsedDose = parseDoseExpression(initial.dose ?? "");

  // v1.16.11 — an as-needed medication persists ZERO schedules; hydrate
  // one placeholder draft carrying the asNeeded mode so the flat mirror
  // and Step-5 selection round-trip (the encode path emits no schedule).
  const asNeeded = initial.asNeeded === true;
  const drafts: ScheduleDraft[] = asNeeded
    ? [{ ...emptyScheduleDraft(), mode: "asNeeded" }]
    : initial.schedules.length > 0
      ? initial.schedules.map((schedule) =>
          hydrateScheduleDraft(schedule, initial.oneShot),
        )
      : [emptyScheduleDraft()];
  const first = drafts[0];

  return {
    ...base,
    name: initial.name ?? "",
    doseAmount: parsedDose.amount,
    doseUnit: parsedDose.unit || base.doseUnit,
    treatmentRow: rowFromTreatment(initial.treatmentClass, initial.category),
    deliveryForm: normaliseDeliveryForm(initial.deliveryForm),
    dosesPerUnit:
      typeof initial.dosesPerUnit === "number" && initial.dosesPerUnit >= 1
        ? String(initial.dosesPerUnit)
        : "",
    unitsPerDose:
      typeof initial.unitsPerDose === "number" && initial.unitsPerDose > 0
        ? String(initial.unitsPerDose)
        : "1",
    trackInjectionSites: initial.trackInjectionSites ?? false,
    allowedInjectionSites: (initial.allowedInjectionSites ??
      []) as InjectionSiteKey[],
    mode: first.mode,
    cadence: first.cadence,
    subControls: first.subControls,
    timesOfDay: first.timesOfDay,
    scheduleDose: first.dose ?? "",
    scheduleUnitsPerDose: first.unitsPerDose ?? "",
    doseWindows: first.doseWindows ?? [],
    startsOn: initial.startsOn ?? base.startsOn,
    endsOn: initial.endsOn,
    notificationsEnabled: initial.notificationsEnabled ?? true,
    trackIntake: initial.trackIntake !== false,
    schedules: drafts,
    activeScheduleIndex: 0,
  };
}

/**
 * Decision the dialog uses to pick the landing step on edit-hydrate:
 * Step 1 for a single-schedule medication (a straight top-down walk),
 * Step 8 (the summary list) for a multi-schedule one, where the muscle
 * memory is "see every parallel schedule first".
 */
export function landingStepForEdit(payload: WizardPayload): number {
  return payload.schedules.length > 1 ? 8 : 1;
}

function deriveCadenceFromSchedule(
  schedule: MedicationPayload["schedules"][number],
  oneShot: boolean,
): { value: CadenceValue; subControls: CadenceSubControls } {
  if (oneShot) {
    const sub = { ...DEFAULT_SUB_CONTROLS };
    return { value: encodeCadence("oneShot", sub), subControls: sub };
  }
  if (typeof schedule.rollingIntervalDays === "number") {
    const sub: CadenceSubControls = {
      ...DEFAULT_SUB_CONTROLS,
      rollingDays: schedule.rollingIntervalDays,
    };
    return { value: encodeCadence("rolling", sub), subControls: sub };
  }
  if (typeof schedule.rrule === "string" && schedule.rrule.length > 0) {
    const sub = subControlsFromRrule(schedule.rrule);
    const kind = kindFromRrule(schedule.rrule);
    return { value: encodeCadence(kind, sub), subControls: sub };
  }
  // Legacy fallback — infer from daysOfWeek + intervalWeeks.
  return inferCadenceFromLegacy({
    daysOfWeek: schedule.daysOfWeek ?? [],
    intervalWeeks: schedule.intervalWeeks ?? 1,
  });
}

function kindFromRrule(rrule: string): CadenceKind {
  // Lightweight inspection — the picker re-encodes the RRULE on every
  // change so the wizard never relies on a perfect parse here.
  if (rrule.includes("FREQ=DAILY")) return "daily";
  if (rrule.includes("FREQ=WEEKLY")) {
    return /INTERVAL=([2-9]|[1-9]\d)/.test(rrule) ? "everyNWeeks" : "weekdays";
  }
  if (rrule.includes("FREQ=MONTHLY")) {
    return /INTERVAL=([2-9]|[1-9]\d)/.test(rrule) ? "everyNMonths" : "monthly";
  }
  if (rrule.includes("FREQ=YEARLY")) return "yearly";
  return "daily";
}

function subControlsFromRrule(rrule: string): CadenceSubControls {
  const sub: CadenceSubControls = { ...DEFAULT_SUB_CONTROLS };
  const byday = /BYDAY=([A-Z,]+)/.exec(rrule);
  if (byday) {
    const tokens = byday[1]
      .split(",")
      .filter((t) => ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(t));
    if (tokens.length > 0) {
      sub.weekdays = tokens as CadenceSubControls["weekdays"];
    }
  }
  const interval = /INTERVAL=(\d{1,3})/.exec(rrule);
  if (interval) {
    const n = Number(interval[1]);
    if (rrule.includes("FREQ=WEEKLY")) sub.intervalWeeks = n;
    else if (rrule.includes("FREQ=MONTHLY")) sub.intervalMonths = n;
  }
  const bymonthday = /BYMONTHDAY=(-?\d{1,2})/.exec(rrule);
  if (bymonthday) {
    const n = Number(bymonthday[1]);
    if (n >= 1 && n <= 31) sub.dayOfMonth = n;
  }
  const bymonth = /BYMONTH=(\d{1,2})/.exec(rrule);
  if (bymonth && bymonthday) {
    const month = Number(bymonth[1]);
    const day = Number(bymonthday[1]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      sub.yearlyDate = `${new Date().getUTCFullYear()}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return sub;
}

// ────────────────────────────────────────────────────────────────────
// Re-exports — convenience for the dialog and tests
// ────────────────────────────────────────────────────────────────────

export { dateToIsoString };
