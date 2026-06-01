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

import { encodeCadence } from "@/components/medications/scheduling/CadencePicker";
import {
  dateToIsoString,
  isoStringToDate,
} from "@/components/medications/scheduling/CourseWindowRow";
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
 * The ten taxonomy rows in their visible order. Marc-confirmed (D-1
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
  { treatmentClass: MedicationTreatmentClass; category: MedicationCategoryValue }
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
  mode: "oneShot" | "recurring" | null;
  cadence: CadenceValue;
  subControls: CadenceSubControls;
  timesOfDay: string[];
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
  /** Set in Step 5 — mirrors `schedules[activeScheduleIndex].mode`. */
  mode: "oneShot" | "recurring" | null;
  /** Mirrors `schedules[activeScheduleIndex].cadence`. */
  cadence: CadenceValue;
  /** Mirrors `schedules[activeScheduleIndex].subControls`. */
  subControls: CadenceSubControls;
  /** Mirrors `schedules[activeScheduleIndex].timesOfDay`. */
  timesOfDay: string[];
  startsOn: Date | null;
  endsOn: Date | null;
  notificationsEnabled: boolean;
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
    mode: draft.mode,
    cadence: draft.cadence,
    subControls: draft.subControls,
    timesOfDay: draft.timesOfDay,
    startsOn: todayUtc(),
    endsOn: null,
    notificationsEnabled: true,
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
  };
}

// ────────────────────────────────────────────────────────────────────
// Path table — visible step counter
// ────────────────────────────────────────────────────────────────────

const ONE_SHOT_PATH: readonly number[] = [1, 2, 3, 4, 8];
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
  schedules: Array<{
    id?: string;
    windowStart: string;
    windowEnd: string;
    timesOfDay: string[];
    rrule?: string;
    rollingIntervalDays?: number;
    daysOfWeek?: number[];
    intervalWeeks?: number;
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
  if (!isOneShot) {
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
  const isOneShot = committed.mode === "oneShot";
  const draftsToEmit = isOneShot
    ? [committed.schedules[committed.activeScheduleIndex] ?? committed.schedules[0]]
    : committed.schedules;

  const parsedDosesPerUnit = Number.parseInt(committed.dosesPerUnit, 10);
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
    // v1.5.5 D-3 §10 invariant 16 — `notificationsEnabled` only on
    // create. Edits never round-trip the wizard's default because the
    // detail page's notifications switch is the single source of
    // truth post-create.
    ...(forMode === "create" && {
      notificationsEnabled: committed.notificationsEnabled,
    }),
    oneShot: isOneShot,
    schedules: draftsToEmit.map((draft) => encodeScheduleDraft(draft, isOneShot)),
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

function summaryKeyForCadence(payload: WizardPayload): string {
  return summaryKeyForDraft(payload.mode, payload.cadence, payload.subControls);
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

function cadenceDetailPhrase(
  payload: WizardPayload,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (payload.mode === "oneShot") return "";
  switch (payload.cadence.kind) {
    case "weekdays":
      return weekdaysDetail(payload.subControls.weekdays, t);
    case "everyNWeeks":
      return weekdaysDetail(payload.subControls.weekdays, t);
    case "monthly":
      return t("medications.wizard.summary.dayOfMonthDetail", {
        day: payload.subControls.dayOfMonth,
      });
    default:
      return "";
  }
}

/**
 * Plain-language summary for Step 8. Mirrors v1.5.3's helper shape so
 * the test surface stays familiar. The `t` callback is passed in so
 * the helper stays pure (no React hook coupling).
 */
export function summariseCadence(
  payload: WizardPayload,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const cadenceKey = summaryKeyForCadence(payload);
  const cadencePhrase = t(
    `medications.wizard.summary.cadence.${cadenceKey}`,
    {
      n:
        payload.cadence.kind === "everyNWeeks"
          ? payload.subControls.intervalWeeks
          : payload.cadence.kind === "rolling"
            ? (payload.cadence.rollingIntervalDays ?? 0)
            : 0,
    },
  );
  const cadenceDetail = cadenceDetailPhrase(payload, t);
  const cadenceLine = cadencePhrase + cadenceDetail;
  const timesPhrase =
    payload.mode !== "oneShot" && payload.timesOfDay.length > 0
      ? t("medications.wizard.summary.times", {
          times: sortTimes(payload.timesOfDay).join(", "),
        })
      : "";
  const startPhrase = payload.startsOn
    ? t("medications.wizard.summary.startsOn", {
        date: dateToIsoString(payload.startsOn),
      })
    : "";
  const endPhrase =
    payload.mode === "oneShot"
      ? ""
      : payload.endsOn
        ? t("medications.wizard.summary.endsOn", {
            date: dateToIsoString(payload.endsOn),
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
  const cadenceKey = summaryKeyForDraft(
    draft.mode,
    draft.cadence,
    draft.subControls,
  );
  const cadencePhrase = t(
    `medications.wizard.summary.cadence.${cadenceKey}`,
    {
      n:
        draft.cadence.kind === "everyNWeeks"
          ? draft.subControls.intervalWeeks
          : draft.cadence.kind === "rolling"
            ? (draft.cadence.rollingIntervalDays ?? 0)
            : 0,
    },
  );
  let cadenceDetail = "";
  if (draft.mode !== "oneShot") {
    if (
      draft.cadence.kind === "weekdays" ||
      draft.cadence.kind === "everyNWeeks"
    ) {
      cadenceDetail = weekdaysDetail(draft.subControls.weekdays, t);
    } else if (draft.cadence.kind === "monthly") {
      cadenceDetail = t("medications.wizard.summary.dayOfMonthDetail", {
        day: draft.subControls.dayOfMonth,
      });
    }
  }
  const cadenceLine = cadencePhrase + cadenceDetail;
  const timesPhrase =
    draft.mode !== "oneShot" && draft.timesOfDay.length > 0
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
  notificationsEnabled: boolean;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  schedules: Array<{
    id?: string;
    windowStart: string;
    windowEnd: string;
    label?: string | null;
    dose?: string | null;
    daysOfWeek?: number[];
    intervalWeeks?: number;
    timesOfDay?: string[];
    rrule?: string | null;
    rollingIntervalDays?: number | null;
  }>;
}

/** Coerce a persisted `deliveryForm` string onto the closed enum. */
function normaliseDeliveryForm(value: string | undefined): MedicationDeliveryForm {
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
  daysOfWeek?: number[];
  intervalWeeks?: number;
  timesOfDay?: string[];
  rrule?: string | null;
  rollingIntervalDays?: number | null;
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
  const draft: ScheduleDraft = {
    mode: oneShot ? "oneShot" : "recurring",
    cadence: cadence.value,
    subControls: cadence.subControls,
    timesOfDay: times,
  };
  if (schedule.id) draft.id = schedule.id;
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
export function hydrateWizardPayload(initial: MedicationPayload): WizardPayload {
  const base = emptyWizardPayload();
  const parsedDose = parseDoseExpression(initial.dose ?? "");

  const drafts: ScheduleDraft[] =
    initial.schedules.length > 0
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
    mode: first.mode,
    cadence: first.cadence,
    subControls: first.subControls,
    timesOfDay: first.timesOfDay,
    startsOn: initial.startsOn ?? base.startsOn,
    endsOn: initial.endsOn,
    notificationsEnabled: initial.notificationsEnabled ?? true,
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
    const tokens = byday[1].split(",").filter((t) =>
      ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(t),
    );
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

export { dateToIsoString, isoStringToDate };
