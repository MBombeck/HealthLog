/**
 * Doctor-report data shapes.
 *
 * The interface / constant inventory for the aggregated doctor-report payload
 * (`DoctorReport*` shapes, the wellness-score type list, the canonical-collapse
 * row shape, and the collector option contracts). Split out of
 * `doctor-report-data.ts` as pure code motion; that module re-exports every
 * name here, so existing call sites keep importing from it unchanged. The pure
 * helpers live in `doctor-report-helpers.ts`; the aggregator itself stays in
 * `doctor-report-data.ts`.
 */

import type { GlucoseUnit } from "@/lib/glucose";
import type { GlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { MeasurementSource } from "@/generated/prisma/client";
import type { ModuleKey } from "@/lib/modules/gate";
import type { Glp1SideEffectTag } from "@/lib/medications/glp1-side-effect-tags";
import type {
  ComplianceSchedule,
  IntakeEvent,
  MedicationPauseEraLike,
} from "@/lib/analytics/compliance";
import type { ScheduleRevisionLike } from "@/lib/medications/scheduling/schedule-eras";
import type {
  AlcoholPatternValue,
  ShiftScheduleValue,
  SmokingStatusValue,
} from "@/lib/validations/health-profile-facts";
import type {
  AdvanceDirectiveStatusValue,
  EmergencyBloodTypeValue,
  OrganDonorStatusValue,
} from "@/lib/validations/emergency-profile";

export interface DoctorReportStats {
  avg: number;
  min: number;
  max: number;
  count: number;
  latest: number;
}

export interface DoctorReportCompliance {
  total: number;
  taken: number;
  skipped: number;
  missed: number;
}

export interface DoctorReportMood {
  avg: number;
  min: number;
  max: number;
  count: number;
  distribution: Record<number, number>;
}

export interface DoctorReportData {
  /**
   * Reporting period bounds. `start` and `end` are ISO timestamps; `days` is
   * the inclusive day-count between the two (rounded up) so existing callers
   * that displayed "last N days" continue to work without a UI rewrite.
   */
  period: { days: number; since: string; start: string; end: string };
  patient: {
    username: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    heightCm: number | null;
    // v1.7.0 — optional patient-identity fields for the export cover +
    // FHIR Patient. `fullName` + `insurerName` are plaintext columns; the
    // KVNR is NOT carried here (it's encrypted at rest and decrypted by
    // the route, then handed to the builders separately). Optional in the
    // type so pre-v1.7.0 fixtures that omit them still typecheck — the
    // renderer treats absent and null identically.
    fullName?: string | null;
    insurerName?: string | null;
    // v1.8.6 — German insurer institution number (IKNR), plaintext. Carried
    // here for the FHIR `Coverage` payor Organization identifier. Optional
    // so pre-v1.8.6 fixtures still typecheck.
    insurerIkNumber?: string | null;
  };
  /**
   * Free-text practice / clinic name printed on the cover. `null` omits the
   * line entirely. Persisted as a user preference (see
   * `User.lastReportPracticeName`).
   */
  practiceName: string | null;
  measurements: Record<string, Array<{ value: number; measuredAt: string }>>;
  stats: Record<string, DoctorReportStats>;
  glucoseStats: Record<string, DoctorReportStats>;
  glucoseRanges: Record<string, { min: number; max: number }>;
  glucoseUnit: GlucoseUnit;
  /**
   * v1.17.0 — server-authoritative glucose clinical panel over the report
   * period (TIR / GMI / estimated A1C / CV% + the advanced J-index + LBGI/HBGI
   * tier), computed by `computeGlucoseClinicalMetrics` so the PDF/FHIR export
   * carries the SAME numbers the insights panel and the coach show. Values are
   * canonical mg/dL; `glucoseUnit` drives display conversion at render. Carried
   * as a spot-reading estimate (`isSpotEstimate: true`), gated by
   * `stillLearning` when the period is too thin to assert clinically.
   */
  glucoseClinical: GlucoseClinicalMetrics;
  bmi: number | null;
  compliance: Record<string, DoctorReportCompliance>;
  medications: Array<{
    name: string;
    dose: string;
    // v1.9.0 — optional user/clinician-asserted drug-classification
    // codes. Carried here so the FHIR exporter can emit a coded
    // `medicationCodeableConcept` (ATC primary, RxNorm secondary). NULL
    // when no code was captured — the exporter then emits the pre-v1.9.0
    // text-only concept. Optional in the type so pre-v1.9.0 fixtures
    // still typecheck.
    atcCode?: string | null;
    rxNormCode?: string | null;
    schedules: Array<{
      windowStart: string;
      windowEnd: string;
      label: string | null;
    }>;
  }>;
  /**
   * v1.9.0 — acted medication-intake events over the report window, fed
   * to the FHIR `MedicationAdministration` builder. One entry per intake
   * row the user actually actioned (taken OR explicitly skipped);
   * pending / missed / soft-deleted rows are excluded upstream so the
   * exporter never asserts an administration that did not happen. The
   * `dose` is the medication's structured dose-in-effect at
   * `effectiveAt` (from `MedicationDoseChange`) when one exists, else
   * NULL. Optional so pre-v1.9.0 fixtures still typecheck.
   */
  medicationAdministrations?: Array<{
    medicationName: string;
    /** ISO timestamp: `takenAt` for a taken dose, `scheduledFor` for a skip. */
    effectiveAt: string;
    status: "completed" | "not-done";
    /** Free-text dose label (the medication's `dose`), mirrors the statement. */
    doseText: string | null;
    /** Structured dose-in-effect at `effectiveAt`, when a dose-change history exists. */
    dose: { value: number; unit: string } | null;
    /** Injection site, when the row recorded one. */
    injectionSite: string | null;
    /** ATC / RxNorm codes, mirrored from the medication for the self-describing concept. */
    atcCode: string | null;
    rxNormCode: string | null;
    /** Delivery form — ORAL / INJECTION / OTHER — for the route mapping. */
    deliveryForm: string | null;
  }>;
  /**
   * v1.9.0 — set when the administration cap (see
   * {@link resolveMaxMedicationAdministrations}) trimmed the administration
   * set. `total` is the full acted-intake count over the
   * window; `included` is how many (the most-recent) survived the cap.
   * Null/absent when nothing was trimmed. The FHIR builder discloses
   * this in the document narrative so the export is honest about the
   * omitted (oldest) rows. Optional so pre-v1.9.0 fixtures still typecheck.
   */
  medicationAdministrationsTruncation?: {
    total: number;
    included: number;
  } | null;
  mood: DoctorReportMood | null;
  /**
   * v1.4.25 W4d — GLP-1 therapy section. Populated when the user has at
   * least one active GLP-1 medication. Null/absent when the user has no
   * GLP-1 prescription (the vast majority of accounts). When set the
   * PDF gains a "GLP-1 Therapy" section listing dose history, weight
   * change over the therapy window, side-effect counts, and compliance.
   * Optional in the type so legacy callers + test fixtures that omit
   * the field continue to work; the renderer treats absent and null
   * identically.
   */
  glp1?: {
    medications: Array<{
      name: string;
      currentDose: { value: number; unit: string; since: string } | null;
      doseHistory: Array<{
        value: number;
        unit: string;
        effectiveFrom: string;
        note: string | null;
      }>;
      lastInjection: { date: string; site: string | null } | null;
      compliance: { taken: number; total: number };
    }>;
    weightDeltaKg: number | null;
    weightStartKg: number | null;
    weightEndKg: number | null;
    /**
     * Side-effect tallies keyed by `Glp1SideEffectTag`, never by the string the
     * mood entry was written with: the report renders in the reader's language
     * and the tag may have been captured in another one. The PDF resolves each
     * key through `GLP1_SIDE_EFFECT_TAG_LABEL_KEYS`.
     */
    sideEffects: Array<{ tag: Glp1SideEffectTag; count: number }>;
  } | null;
  /**
   * v1.10.0 — the server-derived nightly wellness scores
   * (RECOVERY_SCORE / STRESS_SCORE / STRAIN_SCORE), summarised over the
   * report window. These are 0–100 DESCRIPTIVE composites, NOT clinical
   * vitals — they are rendered in a clearly-labelled "Wellness summary"
   * section separate from the clinical vitals table, each with a
   * "descriptive, not a clinical assessment" note. Null/absent when the
   * user has no computed scores in the window (the renderer + FHIR builder
   * then skip the section). Optional so pre-v1.10 fixtures still typecheck.
   */
  wellnessScores?: Array<{
    /** The score MeasurementType (RECOVERY_SCORE / STRESS_SCORE / STRAIN_SCORE). */
    type: string;
    latest: number;
    avg: number;
    min: number;
    max: number;
    count: number;
    /** ISO timestamp of the latest score. */
    latestAt: string;
  }> | null;
  /**
   * v1.15.0 — concise menstrual-cycle summary (LMP, recent cycles, avg
   * length + variability, current phase). Populated ONLY when the `cycle`
   * section toggle is explicitly ON (privacy default OFF — a user sharing a
   * BP report with a cardiologist must not auto-leak reproductive data) AND
   * the user has at least one observed cycle. Statistics only — no free-text
   * notes ever reach this surface. Null/absent otherwise; both the PDF and
   * FHIR builders then skip the section. Optional so pre-v1.15 fixtures
   * still typecheck.
   */
  cycle?: import("@/lib/cycle/export-data").CycleExportSummary | null;
  /**
   * v1.17.1 — structured lab results recorded over the report window.
   * Populated when the `labs` section toggle is ON (default) and the user
   * recorded at least one result in the period. Statistics + the single
   * latest reading per analyte; free-text notes never reach this surface.
   * Each entry carries the lab's reference bounds so the PDF can print an
   * in/out-of-range marker and the FHIR exporter can emit `referenceRange`.
   * Null/absent otherwise; both the PDF and FHIR builders skip the section.
   * Optional so pre-v1.17.1 fixtures still typecheck.
   */
  labResults?: Array<{
    /** Optional grouping label (e.g. "Großes Blutbild"); null = standalone. */
    panel: string | null;
    /** Biomarker name as the user recorded it. */
    analyte: string;
    /**
     * Latest numeric value for this analyte over the window; null for a
     * qualitative reading (see `valueText`). v1.18.9.
     */
    value: number | null;
    /**
     * v1.18.9 — qualitative result text ("negativ" / "positiv" / …); null for a
     * numeric reading. Exactly one of `value` / `valueText` is set.
     */
    valueText: string | null;
    unit: string;
    /**
     * The reference window this reading is judged against: the range printed
     * on its own report when it carries one, the catalog band otherwise.
     * Resolved server-side through `resolveEffectiveReferenceRange` so the PDF
     * marker, the FHIR `referenceRange`, and the API verdict agree.
     */
    referenceLow: number | null;
    referenceHigh: number | null;
    /** The catalog band, kept so the PDF can name a divergence. */
    catalogReferenceLow: number | null;
    catalogReferenceHigh: number | null;
    /** The window the source report printed, verbatim; null when it printed none. */
    sourceReferenceText: string | null;
    /** Which of the two windows `referenceLow` / `referenceHigh` came from. */
    referenceOrigin: "source" | "catalog" | "none";
    /** True when the report's window and the catalog band state different limits. */
    referenceDivergesFromCatalog: boolean;
    /** ISO timestamp of the latest reading. */
    takenAt: string;
    /** Count of readings for this analyte in the window (≥ 1). */
    count: number;
  }> | null;
  /**
   * v1.18.1 P4 — illness / condition episodes overlapping the report window.
   * Populated ONLY when the `illness` module is enabled (default-on, opt-out);
   * the journal is on and shared deliberately, so the privacy stance matches
   * labs (ON when the module is on), not mood / cycle.
   * Statistics + labels only — the free-text note is NEVER read here, so no
   * encrypted plaintext can leak into the report. Each entry feeds a FHIR
   * `Condition` (+ `Encounter`) and a PDF table row. Null/absent when the
   * module is off or no episode overlaps the window; both builders then skip
   * the section. Optional so pre-v1.18.1 fixtures still typecheck.
   */
  /**
   * Visits inside the window — the contacts with the healthcare system this
   * period held. Null when the leaf was not selected or none fell inside the
   * window; both builders then skip the section. Optional so pre-v1.38
   * fixtures still typecheck.
   *
   * `kind` rides as the enum constant: the renderer names it in the REPORT's
   * language, which is the reading clinician's, not whoever generated it.
   * `reason` and `outcome` are the decrypted free text and are null on a
   * key-rotation gap — an absence rather than a fabricated line.
   */
  visits?: Array<{
    occurredAt: string;
    kind: string;
    status: string;
    practitionerName: string | null;
    practitionerSpecialty: string | null;
    reason: string | null;
    outcome: string | null;
    /** Labels of the conditions this visit was filed against. */
    conditionLabels: string[];
  }> | null;
  /**
   * The surgical history (v1.39.1): every visit of kind PROCEDURE that
   * happened, oldest first. Reference data, not time-windowed, like the
   * immunization record below — an operation fifteen years ago is still the
   * answer to "what surgeries have you had". Null when the SURGICAL_HISTORY
   * leaf was not selected or no procedure exists; both builders then skip the
   * section. Optional so older fixtures still typecheck.
   *
   * `procedure` is the visit's reason, which is where a person writes what was
   * done. `procedure`, `bodySite` and `outcome` are decrypted free text and
   * null on a key-rotation gap. `laterality` rides as the enum constant; the
   * renderer names it in the report's language.
   */
  surgicalHistory?: Array<{
    occurredAt: string;
    procedure: string | null;
    bodySite: string | null;
    laterality: string | null;
    outcome: string | null;
    practitionerName: string | null;
  }> | null;
  /**
   * The immunization history. Reference data, not time-windowed — an Impfpass
   * is a lifetime document and a doctor wants the whole of it, so this mirrors
   * the allergies stance rather than the visit window. Populated when the
   * `IMMUNIZATIONS` leaf is selected AND the `vaccinations` module is on AND at
   * least one live dose exists; null/absent otherwise, and the PDF then skips
   * the section. `series` carries the server-resolved position per component
   * antigen so the renderer composes "N of M" without re-deriving it; the
   * catalogue name resolves from `antigenSlug` at render, with `vaccineName`
   * the free-text fallback.
   */
  immunizations?: Array<{
    occurredAt: string;
    antigenSlug: string | null;
    vaccineName: string | null;
    lotNumber: string | null;
    site: string | null;
    practitionerName: string | null;
    series: Array<{
      antigen: string;
      position: number;
      total: number | null;
      booster: boolean;
    }>;
  }> | null;
  illnessEpisodes?: Array<{
    /** User-facing condition label (e.g. "Erkältung"). */
    label: string;
    /** Broad condition class (INFECTION / ALLERGY / INJURY / …). */
    type: string;
    /** Lifecycle (ACUTE / CHRONIC_ONGOING / RECURRING / FLARE). */
    lifecycle: string;
    /** ISO onset instant. */
    onsetAt: string;
    /** ISO resolution instant, or null while ongoing. */
    resolvedAt: string | null;
  }> | null;
  /**
   * v1.27.x — structured allergy / intolerance records. Reference data,
   * not time-windowed: populated whenever the `allergies` section toggle
   * is ON (default) and the user recorded at least one live row. The
   * reaction description is decrypted fail-soft per row (a key-rotation
   * gap omits the value, never fails the report); the free-text note is
   * NEVER read here — same stance as the illness journal. Null/absent
   * otherwise; the PDF builder then skips the section. Optional so older
   * fixtures still typecheck.
   */
  allergies?: Array<{
    /** Substance / allergen label as the user recorded it. */
    substance: string;
    /** Category (FOOD / MEDICATION / ENVIRONMENT / BIOLOGIC / OTHER). */
    category: string;
    /** Kind (ALLERGY / INTOLERANCE). */
    type: string;
    /** Worst observed severity (NONE / MILD / MODERATE / SEVERE), or null. */
    severity: string | null;
    /** Status (ACTIVE / INACTIVE / RESOLVED). */
    status: string;
    /** Decrypted reaction description, or null (genuinely unset). */
    reaction: string | null;
    /**
     * True when a reaction description WAS stored but could not be decrypted
     * (a key-rotation gap / GCM corruption). Distinct from `reaction: null`
     * (nothing recorded) so the clinician-facing report shows an honest
     * "unreadable" marker rather than a blank that reads as "no reaction".
     */
    reactionUnreadable?: boolean;
  }> | null;
  /**
   * v1.27.x — structured family-history records. Reference data, not
   * time-windowed: populated whenever the `familyHistory` section toggle
   * is ON (default) and the user recorded at least one live row. Labels +
   * onset age only — the free-text note is never read here. Null/absent
   * otherwise; the PDF builder then skips the section. Optional so older
   * fixtures still typecheck.
   */
  familyHistory?: Array<{
    /** Relationship (MOTHER / FATHER / SISTER / …). */
    relationship: string;
    /** Condition label as the user recorded it. */
    condition: string;
    /** The relative's age at onset (years), or null when unknown. */
    ageAtOnset: number | null;
  }> | null;
  /**
   * User-selected anamnesis leaf. Unlike optional data sections, this object is
   * present whenever the leaf was selected even when every value is absent, so
   * the clinician sees an honest "not recorded" label rather than silence.
   */
  anamnesis?: {
    conditions: string | null;
    conditionsUnreadable: boolean;
    smokingStatus: SmokingStatusValue | null;
    alcoholPattern: AlcoholPatternValue | null;
    shiftSchedule: ShiftScheduleValue | null;
    unreadableFacts: Array<
      "SMOKING_STATUS" | "ALCOHOL_PATTERN" | "SHIFT_SCHEDULE"
    >;
  } | null;
  /**
   * Emergency ("Notfalldaten") facts for the page-one section. Present only
   * when the `EMERGENCY` leaf was admitted AND at least one field holds a
   * value; null otherwise, and the PDF then emits no emergency page. The three
   * enums cross as constants (the renderer names them in the report's language);
   * the free text decrypts fail-soft, an `*Unreadable` flag distinguishing a
   * key-rotation gap from a genuinely unset field.
   */
  emergency?: {
    bloodType: EmergencyBloodTypeValue | null;
    organDonor: OrganDonorStatusValue | null;
    advanceDirective: AdvanceDirectiveStatusValue | null;
    contacts: string | null;
    contactsUnreadable: boolean;
    implants: string | null;
    implantsUnreadable: boolean;
    note: string | null;
    noteUnreadable: boolean;
  } | null;
}

/** The three persisted score types surfaced in the wellness summary. */
export const WELLNESS_SCORE_REPORT_TYPES = [
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
] as const;

/** Minimal Measurement shape the canonical-source collapse consults. */
export interface CanonicalCollapseRow {
  type: string;
  value: number;
  measuredAt: Date;
  source: MeasurementSource;
  deviceType?: string | null;
}

export interface DoctorReportRange {
  /** Start of the reporting window (UTC, inclusive). */
  start: Date;
  /** End of the reporting window (UTC, inclusive). */
  end: Date;
  /** Inclusive day-count between `start` and `end` (rounded up). */
  days: number;
}

export interface CollectDoctorReportOptions {
  /** Free-text practice/clinic name to print on the cover. Optional. */
  practiceName?: string | null;
  /**
   * v1.18.0 — resolved per-user module enable/disable map. When omitted the
   * aggregator resolves it itself via `resolveModuleMap(userId)`. A disabled
   * module forces its leaves out of the payload regardless of the selection: a
   * user who turned off the Sleep module exports no sleep series, whatever the
   * report asked for. Injectable for tests so the module ↔ leaf mapping can be
   * asserted without a DB.
   *
   * The report SCOPE is not an option — it is the required third parameter of
   * `collectDoctorReportData`, so a new egress path cannot be written without
   * naming where its selection came from.
   */
  moduleMap?: Record<ModuleKey, boolean>;
}

/**
 * v1.17 W1a — the medication row shape the ledger compliance builder needs.
 * Carries the cadence-engine context fields (course window + creation +
 * archived schedule eras) so the same band minter the detail page uses can
 * reconstruct expected slots.
 */
export interface DoctorReportComplianceMedication {
  id: string;
  name: string;
  asNeeded: boolean;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  createdAt: Date;
  schedules: ComplianceSchedule[];
  scheduleRevisions?: ScheduleRevisionLike[];
  /** v1.25 H-MED1 — pause eras so paused days drop out of the denominator. */
  pauseEras?: MedicationPauseEraLike[];
}

/** A window-bounded intake row keyed to its medication. */
export interface DoctorReportComplianceIntake extends IntakeEvent {
  medicationId: string;
}
