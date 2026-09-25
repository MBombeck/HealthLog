/**
 * Cycle row → wire-DTO mappers (ios-contract §2 + §3).
 *
 * The canonical `CycleDayLogDTO` and `MenstrualCycleDTO` shapes the iOS
 * client mirrors. `notesEncrypted` is decrypted fail-soft on read (a
 * key-rotation gap on one row reads `null`, never 500s the whole page).
 * Symptom links are flattened to `[{ key, severity }]` using the catalog
 * key; `severity` carries the persisted per-link 1-4 Likert intensity
 * (NULL = a plain presence link).
 */
import { decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";
import type { CyclePredictionResult } from "@/lib/cycle/types";
import type {
  CycleDayLog,
  CycleSymptomLink,
  CycleSymptom,
  MenstrualCycle,
} from "@/generated/prisma/client";

export interface CycleSymptomDTO {
  key: string;
  severity: number | null;
}

export interface CycleDayLogDTO {
  id: string;
  date: string;
  cycleId: string | null;
  flow: string | null;
  intermenstrualBleeding: boolean;
  basalBodyTempC: number | null;
  /** Whether the day's BBT is marked disturbed (excluded from the engine). */
  temperatureExcluded: boolean;
  ovulationTest: string | null;
  cervicalMucus: string | null;
  /** Cervix observation signs (symptothermal secondary indicator). */
  cervixPosition: string | null;
  cervixFirmness: string | null;
  cervixOpening: string | null;
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: string | null;
  progesteroneTest: string | null;
  contraceptive: string | null;
  symptoms: CycleSymptomDTO[];
  note: string | null;
  source: string;
  externalId: string | null;
  syncVersion: number;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MenstrualCycleDTO {
  id: string;
  startDate: string;
  endDate: string | null;
  periodEndDate: string | null;
  lengthDays: number | null;
  ovulationDate: string | null;
  ovulationConfirmed: boolean;
  isPredicted: boolean;
  syncVersion: number;
  updatedAt: string;
}

type DayLogWithLinks = CycleDayLog & {
  symptomLinks?: (CycleSymptomLink & { symptom: Pick<CycleSymptom, "key"> })[];
};

/** Decrypt a day-log note fail-soft (null on missing / undecryptable). */
function decryptNote(notesEncrypted: string | null): string | null {
  if (!notesEncrypted) return null;
  try {
    return decrypt(notesEncrypted);
  } catch (err) {
    // A note WAS stored but is undecryptable (key-rotation gap / corruption).
    // Fail soft to null so one bad row never throws the day-log read, but log
    // it (F-CRYPTO-2) so a systemic key gap surfaces instead of silently
    // reading as an empty note.
    getEvent()?.addWarning(
      `cycle day-log note decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

interface SensitiveEnvelope {
  sexualActivity?: boolean;
  protectedSex?: boolean | null;
  pregnancyTest?: string | null;
  progesteroneTest?: string | null;
  contraceptive?: string | null;
}

/**
 * Decrypt the sensitive-category envelope fail-soft. When
 * `sensitiveCategoryEncryption` was ON at write the five intent fields live
 * here instead of the plaintext columns; an undecryptable envelope reads as
 * an empty object so the page never 500s.
 */
function decryptSensitive(envelope: string | null): SensitiveEnvelope {
  if (!envelope) return {};
  try {
    return JSON.parse(decrypt(envelope)) as SensitiveEnvelope;
  } catch {
    return {};
  }
}

/** The five intent-revealing fields, as a reader should see them. */
interface ResolvedSensitiveFields {
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: string | null;
  progesteroneTest: string | null;
  contraceptive: string | null;
}

/**
 * Resolve the intent-revealing fields of one day-log row: from the encryption
 * envelope when the row carries one, else from the plaintext columns (the
 * flag-OFF path). The day-log read and the calendar grid both go through here,
 * so a day cannot show intercourse in one and not the other.
 */
export function resolveSensitiveFields(
  row: Pick<
    CycleDayLog,
    | "sensitiveEncrypted"
    | "sexualActivity"
    | "protectedSex"
    | "pregnancyTest"
    | "progesteroneTest"
    | "contraceptive"
  >,
): ResolvedSensitiveFields {
  if (row.sensitiveEncrypted != null) {
    const enc = decryptSensitive(row.sensitiveEncrypted);
    return {
      sexualActivity: enc.sexualActivity ?? false,
      protectedSex: enc.protectedSex ?? null,
      pregnancyTest: enc.pregnancyTest ?? null,
      progesteroneTest: enc.progesteroneTest ?? null,
      contraceptive: enc.contraceptive ?? null,
    };
  }
  return {
    sexualActivity: row.sexualActivity,
    protectedSex: row.protectedSex,
    pregnancyTest: row.pregnancyTest,
    progesteroneTest: row.progesteroneTest,
    contraceptive: row.contraceptive,
  };
}

export function toCycleDayLogDTO(row: DayLogWithLinks): CycleDayLogDTO {
  return {
    id: row.id,
    date: row.date,
    cycleId: row.cycleId,
    flow: row.flow,
    intermenstrualBleeding: row.intermenstrualBleeding,
    basalBodyTempC: row.basalBodyTempC,
    temperatureExcluded: row.temperatureExcluded,
    ovulationTest: row.ovulationTest,
    cervicalMucus: row.cervicalMucus,
    cervixPosition: row.cervixPosition,
    cervixFirmness: row.cervixFirmness,
    cervixOpening: row.cervixOpening,
    ...resolveSensitiveFields(row),
    symptoms: (row.symptomLinks ?? []).map((l) => ({
      key: l.symptom.key,
      severity: l.severity ?? null,
    })),
    note: decryptNote(row.notesEncrypted),
    source: row.source,
    externalId: row.externalId,
    syncVersion: row.syncVersion,
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export function toMenstrualCycleDTO(row: MenstrualCycle): MenstrualCycleDTO {
  return {
    id: row.id,
    startDate: row.startDate,
    endDate: row.endDate,
    periodEndDate: row.periodEndDate,
    lengthDays: row.lengthDays,
    ovulationDate: row.ovulationDate,
    ovulationConfirmed: row.ovulationConfirmed,
    isPredicted: row.isPredicted,
    syncVersion: row.syncVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The Prisma `include` that hydrates symptom links → DTO keys. */
export const dayLogSymptomInclude = {
  symptomLinks: { include: { symptom: { select: { key: true } } } },
} as const;

export interface CyclePredictionDTO {
  method: string;
  nextPeriodStart: string;
  nextPeriodStartLow: string;
  nextPeriodStartHigh: string;
  fertileWindowStart: string | null;
  fertileWindowEnd: string | null;
  predictedOvulation: string | null;
  /** Whether `predictedOvulation` was confirmed by a signal layer (BBT / symptothermal). */
  ovulationConfirmed: boolean;
  confidence: number;
  cyclesObserved: number;
  stillLearning: boolean;
  disclaimer: string;
}

/**
 * Map the engine result to the wire `CyclePredictionDTO`. Fertile-window
 * fields (and the predicted ovulation) are suppressed unless the goal
 * permits them (ios-contract §2.D — GENERAL_HEALTH / PERIMENOPAUSE / OFF
 * never surface a fertile window; the suppression is server-side, never
 * iOS).
 */
export function toCyclePredictionDTO(
  result: CyclePredictionResult,
  goalAllowsFertile: boolean,
  disclaimer: string,
): CyclePredictionDTO {
  return {
    method: result.method,
    nextPeriodStart: result.nextPeriodStart,
    nextPeriodStartLow: result.nextPeriodStartLow,
    nextPeriodStartHigh: result.nextPeriodStartHigh,
    // Fertile-window + predicted ovulation are suppressed both when the goal
    // forbids them AND while still learning (<3 cycles): below that we would be
    // emitting a population-prior guess, not a data-grounded estimate. Making
    // the gate structural here (not just in the web panels / calendar grid)
    // means iOS — and any client reading `prediction.*` directly — cannot paint
    // a fertile window the rest of the app refuses to show. `ovulationConfirmed`
    // stays goal-gated only: a confirmed shift is observed data, not a prior.
    fertileWindowStart:
      goalAllowsFertile && !result.stillLearning
        ? result.fertileWindowStart
        : null,
    fertileWindowEnd:
      goalAllowsFertile && !result.stillLearning
        ? result.fertileWindowEnd
        : null,
    predictedOvulation:
      goalAllowsFertile && !result.stillLearning
        ? result.predictedOvulation
        : null,
    ovulationConfirmed: goalAllowsFertile ? result.ovulationConfirmed : false,
    confidence: result.confidence,
    cyclesObserved: result.cyclesObserved,
    stillLearning: result.stillLearning,
    disclaimer,
  };
}

/** The full profile read DTO (ios-contract §2.G). */
export interface CycleProfileDTO {
  goal: string;
  cycleTrackingEnabled: boolean;
  /** Symptothermal secondary symptom — MUCUS (default) or CERVIX. */
  secondarySymptom: string;
  rawChartMode: boolean;
  predictionEnabled: boolean;
  discreetNotifications: boolean;
  sensitiveCategoryEncryption: boolean;
  typicalCycleLength: number | null;
  typicalPeriodLength: number | null;
  lutealPhaseLength: number | null;
  updatedAt: string;
}

export function toCycleProfileDTO(
  row: MenstrualCycleProfileRow,
  cycleTrackingEnabled: boolean,
): CycleProfileDTO {
  return {
    goal: row.goal,
    cycleTrackingEnabled,
    secondarySymptom: row.secondarySymptom,
    rawChartMode: row.rawChartMode,
    predictionEnabled: row.predictionEnabled,
    discreetNotifications: row.discreetNotifications,
    sensitiveCategoryEncryption: row.sensitiveCategoryEncryption,
    typicalCycleLength: row.typicalCycleLength,
    typicalPeriodLength: row.typicalPeriodLength,
    lutealPhaseLength: row.lutealPhaseLength,
    updatedAt: row.updatedAt.toISOString(),
  };
}

type MenstrualCycleProfileRow = {
  goal: string;
  secondarySymptom: string;
  rawChartMode: boolean;
  predictionEnabled: boolean;
  discreetNotifications: boolean;
  sensitiveCategoryEncryption: boolean;
  typicalCycleLength: number | null;
  typicalPeriodLength: number | null;
  lutealPhaseLength: number | null;
  updatedAt: Date;
};

/**
 * Whether a goal surfaces the fertile window. Per algorithm.md §4 the window is
 * shown for TRYING_TO_CONCEIVE and AVOID_PREGNANCY (AVOID_PREGNANCY carries a
 * stronger "estimate, not a contraceptive method" caveat in the copy), and
 * suppressed for GENERAL_HEALTH / PERIMENOPAUSE / OFF (the suppression is always
 * server-side, never iOS).
 */
export function goalAllowsFertileWindow(goal: string): boolean {
  // algorithm.md §4: shown for TRYING_TO_CONCEIVE AND AVOID_PREGNANCY (the
  // latter carries a stronger "not a contraceptive method" caveat in copy),
  // hidden for GENERAL_HEALTH / PERIMENOPAUSE / OFF.
  return goal === "TRYING_TO_CONCEIVE" || goal === "AVOID_PREGNANCY";
}

/**
 * The i18n key for the disclaimer a goal must show. AVOID_PREGNANCY surfaces the
 * fertile window, so it MUST carry the stronger "not a contraceptive method —
 * never safe to assume unprotected sex" copy (`cycle.disclaimer`); every other
 * goal gets the standard "estimates, not medical advice" line
 * (`cycle.prediction.disclaimer`). Shared by the server route and the client so
 * web/iOS/engine show the same caveat. (algorithm.md §4 — safety-relevant.)
 */
export function cycleDisclaimerKey(goal: string): string {
  return goal === "AVOID_PREGNANCY"
    ? "cycle.disclaimer"
    : "cycle.prediction.disclaimer";
}
