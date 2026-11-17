/**
 * The seizure-diary section of the doctor report (#1368): its wire shape.
 *
 * Client-safe types only; the loader is `./report.ts`. Every figure is
 * derived server-side from the recorded seizures, so the PDF, the clinician
 * view and any other renderer print the same numbers and none re-derives them.
 * Nothing here diagnoses, scores a risk or names an outcome; the overlays are
 * descriptive co-occurrences, labelled as such where they are printed.
 */
import type { SeizureIlaeType } from "./ilae";
import type { ClusterRule } from "./derive";
import type {
  SeizureEmergency,
  SeizureFunctionState,
  SeizureInjury,
  SeizurePostictal,
  SeizureObserverRole,
  SeizureRescueEffect,
  SeizureRescueRoute,
  SeizureSleepState,
  SeizureTrigger,
} from "./shared";

export interface SeizureReportType {
  /** The type profile id, or null for seizures recorded without a type. */
  id: string | null;
  /** The family's own name; null for the untyped row or an unreadable name. */
  label: string | null;
  ilaeType: SeizureIlaeType | null;
  usualDurationSec: number | null;
}

export interface SeizureReportSummary {
  seizures: number;
  suspected: number;
  seizureDays: number;
  seizureFreeDays: number;
  per28Days: number;
  longestFreeDays: number;
  daysSinceLast: number | null;
  convulsive: number;
  fromSleep: number;
  clusterEpisodes: number;
  niceClusterEpisodes: number;
  rescueDoses: number;
  emsCalled: number;
  edVisits: number;
  admissions: number;
}

export interface SeizureReportMonthlyRow {
  typeId: string | null;
  /** Seizures per `YYYY-MM`, aligned with `months`. */
  counts: number[];
  /** Seizure days per `YYYY-MM`, aligned with `months`. */
  days: number[];
  total: number;
}

export interface SeizureReportMarker {
  /** `YYYY-MM-DD` in the report zone. */
  date: string;
  medicationName: string;
  kind: "start" | "stop" | "change";
  /** For a change: the new dose, e.g. "300 mg". */
  dose: string | null;
}

export interface SeizureReportDurationRow {
  typeId: string | null;
  timed: number;
  medianSec: number | null;
  maxSec: number | null;
  /** Trinka t1 for the type in seconds, null where none is defined. */
  t1Sec: number | null;
  overT1: number;
  /** At least 2 minutes over the usual duration (NICE). */
  prolonged: number;
}

export interface SeizureReportRescueRow {
  givenAt: string;
  medicationName: string;
  dose: string | null;
  route: SeizureRescueRoute | null;
  givenBy: SeizureObserverRole | null;
  /** Minutes from the seizure's onset, when both times are known. */
  minutesFromOnset: number | null;
  effect: SeizureRescueEffect;
}

export interface SeizureReportCycleOverlay {
  /** Complete tracked cycles the period covers. */
  cycles: number;
  /** Confirmed seizures by cycle day (index 0 = day 1), capped at day 40. */
  byCycleDay: number[];
  /**
   * Rate ratios (seizures per day inside the window over outside it) for
   * Herzog's perimenstrual (C1, day −3 to +3) and periovulatory (C2, day 10
   * to −13) windows. Null below three complete cycles.
   */
  c1Ratio: number | null;
  c2Ratio: number | null;
}

export interface SeizureReportOverlays {
  /**
   * Seizures with a scheduled dose missed or skipped in the 48 hours before,
   * of the seizures in the period. Null without scheduled medications.
   */
  missedDose: { followed: number; of: number } | null;
  cycle: SeizureReportCycleOverlay | null;
  /**
   * Mean recorded sleep (minutes) of the night before a seizure day against
   * the other nights of the period. Null without enough sleep data.
   */
  sleep: {
    beforeSeizureDays: number;
    otherNights: number;
    nightsBefore: number;
    nightsOther: number;
  } | null;
  /** Seizures whose onset fell inside a recorded illness episode. */
  illness: { during: number; episodes: number } | null;
}

export interface SeizureReportRescueDetail {
  medicationId: string | null;
  medicationName: string;
  doseAmount: number | null;
  doseUnit: string | null;
  route: SeizureRescueRoute | null;
  givenAt: string;
  givenBy: SeizureObserverRole | null;
  effect: SeizureRescueEffect;
}

export interface SeizureReportEventRow {
  /** The seizure's id, stable across exports of the same record. */
  id: string;
  onsetAt: string;
  onsetUnknown: boolean;
  typeId: string | null;
  ilaeType: SeizureIlaeType | null;
  count: number;
  suspected: boolean;
  durationSec: number | null;
  estimated: boolean;
  sleepState: SeizureSleepState;
  rescue: boolean;
  injury: boolean;
  /** The note, cut to a line. */
  note: string | null;
  responsiveness: SeizureFunctionState | null;
  recall: SeizureFunctionState | null;
  postictal: SeizurePostictal[];
  injuries: SeizureInjury[];
  triggers: SeizureTrigger[];
  emergency: SeizureEmergency;
  witnessed: boolean | null;
  witnessRole: SeizureObserverRole | null;
  /** Logged by somebody other than the person (a guardian, a carer). */
  loggedByDelegate: boolean;
  rescueDoses: SeizureReportRescueDetail[];
}

export interface SeizureReportSection {
  rule: ClusterRule;
  niceRule: ClusterRule;
  types: SeizureReportType[];
  summary: SeizureReportSummary;
  months: string[];
  monthly: SeizureReportMonthlyRow[];
  monthlyTotal: SeizureReportMonthlyRow;
  markers: SeizureReportMarker[];
  durations: SeizureReportDurationRow[];
  rescue: SeizureReportRescueRow[];
  triggers: Array<{ trigger: SeizureTrigger; count: number }>;
  overlays: SeizureReportOverlays;
  /** Every event in the window, oldest first. The PDF lists the latest 200. */
  events: SeizureReportEventRow[];
  /** Cluster episodes under the record's rule, for the FHIR export. */
  clusters: Array<{
    startAt: string;
    endAt: string;
    seizureCount: number;
    eventIds: string[];
  }>;
  /** Confirmed seizures per calendar day over the trailing 12 months. */
  trailingYearPerDay: number[];
}
