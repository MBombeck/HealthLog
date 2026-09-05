"use client";

/**
 * v1.15.0 — cycle read + write hooks.
 *
 * Reads unwrap `(await res.json()).data` per the project envelope rule;
 * every key is factory-routed through `queryKeys.cycle*`. Writes invalidate
 * the whole `["cycle"]` prefix via `cycleDependentKeys` so the calendar,
 * wheel, predictions panel, and history repaint in lockstep after a quick
 * log.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { randomId } from "@/lib/random-id";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";

import {
  cycleDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import type {
  CalendarResponse,
  CervicalMucus,
  CervixFirmness,
  CervixOpening,
  CervixPosition,
  ContraceptiveKind,
  CycleDayLogDTO,
  CycleDayLogInput,
  CycleHistoryResponse,
  CycleProfileDTO,
  CycleSymptomSelection,
  FlowLevel,
  HomeTestResult,
  OvulationTest,
} from "./types";
import type { CyclePhaseCrosstabRow } from "./cycle-phase-crosstab";

/** One symptom's per-phase clustering (mirrors `SymptomPhasePatternRow`). */
export interface SymptomPhaseRow {
  symptomKey: string;
  counts: {
    MENSTRUAL: number;
    FOLLICULAR: number;
    OVULATORY: number;
    LUTEAL: number;
  };
  total: number;
  topPhase: "MENSTRUAL" | "FOLLICULAR" | "OVULATORY" | "LUTEAL";
  topShare: number;
}

/** The `/api/cycle/insights` read: the phase-contrast rows + the headline. */
export interface CycleInsightsResponse {
  rows: CyclePhaseCrosstabRow[];
  headline: CyclePhaseCrosstabRow | null;
  symptomPatterns: SymptomPhaseRow[];
}

/**
 * The local-timezone `YYYY-MM-DD` for a Date (default: now). Cycle day-keys
 * are tz-anchored on the server; the client must derive the key from the
 * user's wall-clock day, never from `toISOString()` (which is UTC and rolls
 * the date over near midnight).
 */
export function localYmd(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Read the full day-log for one date so the log-day sheet pre-fills (no
 * blank-sheet data loss) and Delete can resolve the row id. `null` when
 * nothing is logged that day. Enabled only when a date is supplied.
 */
export function useCycleDayLog(date: string | null) {
  return useQuery({
    queryKey: queryKeys.cycleDayLog(date ?? ""),
    enabled: date !== null,
    queryFn: () =>
      apiGet<CycleDayLogDTO | null>(`/api/cycle/day-logs?date=${date}`),
    staleTime: 30_000,
  });
}

/**
 * The calendar read for one window. `enabled` exists for the month grid's own
 * read: the page's anchored window covers today, and a month the grid
 * navigates outside it needs a second, bounded read rather than a widened
 * anchor the route's span cap would refuse.
 */
export function useCycleCalendar(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.cycleCalendar(from, to),
    enabled,
    queryFn: () =>
      apiGet<CalendarResponse>(`/api/cycle/calendar?from=${from}&to=${to}`),
    staleTime: 60_000,
  });
}

export function useCycleHistory(limit = 24) {
  return useQuery({
    queryKey: queryKeys.cycleHistory(limit),
    queryFn: () =>
      apiGet<CycleHistoryResponse>(`/api/cycle/cycles?limit=${limit}`),
    staleTime: 60_000,
  });
}

/** One per-user custom symptom: a `custom:<uuid>` key + decrypted label. */
export interface CustomSymptomDTO {
  key: string;
  label: string | null;
  icon: string | null;
  custom: true;
}

/**
 * The caller's own custom symptoms, labels decrypted server-side. The log-day
 * sheet merges these into the seeded chip grid under the `custom` category.
 */
export function useCustomSymptoms() {
  return useQuery({
    queryKey: queryKeys.cycleCustomSymptoms(),
    queryFn: () =>
      apiGet<{ symptoms: CustomSymptomDTO[] }>("/api/cycle/symptoms/custom"),
    staleTime: 5 * 60_000,
  });
}

/** The `errorCode` the create POST returns when the per-user cap is hit. */
export const CUSTOM_SYMPTOM_LIMIT_ERROR_CODE = "cycle.symptom.custom.limit";

/** An error that preserves the envelope `errorCode` so callers can branch. */
export class CustomSymptomError extends Error {
  constructor(
    public readonly errorCode: string | null,
    public readonly status: number,
  ) {
    super(errorCode ?? `Request failed: ${status}`);
    this.name = "CustomSymptomError";
  }
}

/** Create a custom symptom (mint `custom:<uuid>`, encrypt the label). */
export function useCreateCustomSymptom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { label: string; icon?: string | null }) => {
      try {
        return await apiPost<CustomSymptomDTO>(
          "/api/cycle/symptoms/custom",
          input,
        );
      } catch (e) {
        // Preserve the envelope errorCode so the UI can tell the cap hit
        // (cycle.symptom.custom.limit) apart from a transient/validation error.
        if (e instanceof ApiError) {
          throw new CustomSymptomError(
            (e.meta?.errorCode as string | undefined) ?? null,
            e.status,
          );
        }
        throw e;
      }
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.cycleCustomSymptoms() }),
  });
}

/** Soft-hide a custom symptom by its key (history-preserving). */
export function useDeleteCustomSymptom() {
  const qc = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (key: string) => {
      return apiDelete<{ key: string; purged: boolean }>(
        `/api/cycle/symptoms/custom/${encodeURIComponent(key)}`,
      );
    },
    onSuccess: () => invalidateKeys(qc, cycleDependentKeys),
    // v1.16.4 — a failed delete used to fail silently (the sheet clears the
    // chip optimistically), so surface the rejection.
    onError: () => toast.error(t("cycle.deleteError")),
  });
}

export function useCycleProfile() {
  return useQuery({
    queryKey: queryKeys.cycleProfile(),
    queryFn: () => apiGet<CycleProfileDTO>("/api/cycle/profile"),
    staleTime: 5 * 60_000,
  });
}

/**
 * The FDR-guarded phase-correlation surface: the luteal-vs-follicular contrast
 * rows + the one headline finding. Gated server-side; reads only on the cycle
 * insights tab.
 */
export function useCycleInsights() {
  // The lagged rows come back with a narrated `interpretation` in the reader's
  // language, so the cache cell belongs to one language — otherwise a switch
  // would keep serving the sentence written for the previous one.
  const { locale } = useTranslations();
  return useQuery({
    queryKey: queryKeys.cycleInsights(locale),
    queryFn: () => apiGet<CycleInsightsResponse>("/api/cycle/insights"),
    staleTime: 5 * 60_000,
  });
}

/** A fresh idempotency key per write attempt (matches the iOS Outbox shape). */
function idempotencyKey(): string {
  return randomId();
}

/**
 * Capture one day.
 *
 * The success toast is not decoration. A day-log write is silent by nature —
 * the sheet closes and the grid repaints — and for a back-dated entry the grid
 * had nothing to repaint, so a save that worked and a save that never happened
 * looked identical. A write says so now, either way: this names the success and
 * the sheet's inline strip names the failure.
 */
export function useLogDay() {
  const qc = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (input: CycleDayLogInput) => {
      return apiPost<unknown>("/api/cycle/day-logs", input, {
        headers: { "Idempotency-Key": idempotencyKey() },
      });
    },
    onSuccess: () => {
      void invalidateKeys(qc, cycleDependentKeys);
      toastWrittenOutcome("success", t("cycle.saveSuccess"));
    },
  });
}

/**
 * The PATCH body for editing an existing day-log. Every field nullable so the
 * web sheet can CLEAR a previously-set value (the POST merge can only add or
 * keep — it never nulls an omitted field, so an edit that deselects a chip must
 * route through PATCH with an explicit null).
 */
export interface CycleDayLogPatch {
  flow?: FlowLevel | null;
  intermenstrualBleeding?: boolean;
  basalBodyTempC?: number | null;
  temperatureExcluded?: boolean;
  ovulationTest?: OvulationTest | null;
  cervicalMucus?: CervicalMucus | null;
  cervixPosition?: CervixPosition | null;
  cervixFirmness?: CervixFirmness | null;
  cervixOpening?: CervixOpening | null;
  sexualActivity?: boolean;
  protectedSex?: boolean | null;
  pregnancyTest?: HomeTestResult | null;
  progesteroneTest?: HomeTestResult | null;
  contraceptive?: ContraceptiveKind | null;
  symptoms?: CycleSymptomSelection[];
  note?: string | null;
}

/** Edit an existing day-log by id (PATCH — accepts explicit null to clear). */
export function usePatchDayLog() {
  const qc = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: CycleDayLogPatch;
    }) => {
      return apiPatch<CycleDayLogDTO>(`/api/cycle/day-logs/${id}`, patch);
    },
    onSuccess: () => {
      void invalidateKeys(qc, cycleDependentKeys);
      toastWrittenOutcome("success", t("cycle.saveSuccess"));
    },
  });
}

export function useStartPeriod() {
  const qc = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (date: string) => {
      return apiPost<unknown>("/api/cycle/period", {
        action: "start",
        date,
        loggedAt: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      void invalidateKeys(qc, cycleDependentKeys);
      toastWrittenOutcome("success", t("cycle.periodStartSaved"));
    },
    // v1.16.4 — period boundaries had no failure signal at all (the sheet
    // simply stayed open); a toast names the rejection.
    onError: () => toast.error(t("cycle.saveError")),
  });
}

/** The one-tap "end period" boundary (`action:"end"`). */
export function useEndPeriod() {
  const qc = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (date: string) => {
      return apiPost<unknown>("/api/cycle/period", {
        action: "end",
        date,
        loggedAt: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      void invalidateKeys(qc, cycleDependentKeys);
      toastWrittenOutcome("success", t("cycle.periodEndSaved"));
    },
    onError: () => toast.error(t("cycle.saveError")),
  });
}

/** Soft-delete a logged day by its row id (the GET supplies the id). */
export function useDeleteDayLog() {
  const qc = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/api/cycle/day-logs/${id}`);
    },
    onSuccess: () => {
      void invalidateKeys(qc, cycleDependentKeys);
      toastWrittenOutcome("success", t("cycle.deleteSuccess"));
    },
    onError: () => toast.error(t("cycle.deleteError")),
  });
}

export interface CyclePrefsPatch {
  enabled?: boolean;
  goal?: CycleProfileDTO["goal"];
  secondarySymptom?: CycleProfileDTO["secondarySymptom"];
  rawChartMode?: boolean;
  predictionEnabled?: boolean;
  discreetNotifications?: boolean;
  sensitiveCategoryEncryption?: boolean;
  typicalCycleLength?: number | null;
  typicalPeriodLength?: number | null;
  lutealPhaseLength?: number | null;
}

export function useUpdateCyclePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: CyclePrefsPatch) => {
      return apiPatch<CycleProfileDTO>("/api/auth/me/cycle-prefs", patch);
    },
    onSuccess: () => {
      void invalidateKeys(qc, cycleDependentKeys);
      // The enable flag + goal live on /api/auth/me too — repaint the nav gate.
      void qc.invalidateQueries({ queryKey: queryKeys.authMe() });
    },
  });
}
