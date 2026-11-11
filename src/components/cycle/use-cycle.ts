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
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { showErrorToast } from "@/lib/errors/error-toast";

import {
  ApiError,
  apiDelete,
  apiGet,
  apiGetList,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { useDisplayTimezone, useTranslations } from "@/lib/i18n/context";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { randomId } from "@/lib/random-id";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useCalendarDate } from "@/hooks/use-calendar-date";
import { readFailureKind } from "@/lib/api/read-failure";

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
 * Today, and the window the cycle page, its ring and its summary card read
 * (90 days back, 180 ahead), in the record's display zone. The server keys
 * cycle days, "today" included, in the profile zone; the device clock put
 * the highlighted day and the day a log lands on one apart from it when a
 * phone sat in another zone near midnight. One window, so the three readers
 * share one cache entry.
 */
export function useCycleWindow(): { today: string; from: string; to: string } {
  const timeZone = useDisplayTimezone();
  return useMemo(() => {
    const today = userDayKey(new Date(), timeZone);
    return {
      today,
      from: shiftDateKey(today, -90),
      to: shiftDateKey(today, 180),
    };
  }, [timeZone]);
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

/** The calendar window the cycle ring reads: the cycle page's own. */
export function useCycleRingCalendar(enabled = true) {
  const { from, to } = useCycleWindow();
  return useCycleCalendar(from, to, enabled);
}

/**
 * Whether the cycle ring would draw a dial today, and whether that is still
 * unknown. The wellness strip asks this before it gives the ring a cell (and
 * takes Strain's place for it): the ring renders nothing without an active
 * cycle, and a cell reserved for it would sit empty in the row. While the
 * calendar read is `pending` the strip holds its skeleton, so it never paints
 * Strain and then swaps it for the ring. A failed read draws no dial but is
 * `failed`: the strip still gives the ring its cell, where the tile says the
 * read failed and offers a retry. Settling it to "no dial" passed a failure
 * off as a day without an active cycle.
 */
export function useCycleRingDial(enabled: boolean): {
  dial: boolean;
  pending: boolean;
  failed: boolean;
} {
  const calendar = useCycleRingCalendar(enabled);
  const verdict = calendar.data?.verdict;
  return {
    dial: enabled && verdict?.phase != null && verdict.dayOfCycle != null,
    pending: enabled && calendar.isPending,
    // A refused read is not a failure to report: the tile would draw nothing
    // and leave its cell empty.
    failed:
      enabled &&
      calendar.isError &&
      !calendar.data &&
      readFailureKind(calendar.error) !== "refused",
  };
}

/** The latest `limit` cycles, with the route's cap beside them. */
export function useCycleHistory(limit = 24) {
  return useQuery({
    queryKey: queryKeys.cycleHistory(limit),
    queryFn: () =>
      apiGetList<CycleHistoryResponse>(`/api/cycle/cycles?limit=${limit}`),
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
    onError: (failure) =>
      showErrorToast(t("cycle.deleteError"), { cause: failure }),
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

/**
 * A period start the server folded in or gave back (v1.43). The server names
 * it; the toast only says it, so the person learns which date moved without
 * comparing the calendar before and after.
 */
export interface CycleStartRef {
  cycleId: string;
  startDate: string;
}

/** The toast after a write that may have given starts back. */
function useRestoredStartsMessage() {
  const { t } = useTranslations();
  const formatDay = useCalendarDate();
  return (fallback: string, restored: readonly CycleStartRef[] | undefined) =>
    restored && restored.length > 0
      ? t("cycle.startRestored", {
          dates: restored.map((r) => formatDay(r.startDate)).join(", "),
        })
      : fallback;
}

/** Edit an existing day-log by id (PATCH — accepts explicit null to clear). */
export function usePatchDayLog() {
  const qc = useQueryClient();
  const { t } = useTranslations();
  const restoredMessage = useRestoredStartsMessage();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: CycleDayLogPatch;
    }) => {
      return apiPatch<CycleDayLogDTO & { restored?: CycleStartRef[] }>(
        `/api/cycle/day-logs/${id}`,
        patch,
      );
    },
    onSuccess: (data) => {
      void invalidateKeys(qc, cycleDependentKeys);
      toastWrittenOutcome(
        "success",
        restoredMessage(t("cycle.saveSuccess"), data?.restored),
      );
    },
  });
}

export function useStartPeriod() {
  const qc = useQueryClient();
  const { t } = useTranslations();
  const formatDay = useCalendarDate();
  return useMutation({
    mutationFn: async (date: string) => {
      return apiPost<{ absorbed?: CycleStartRef | null }>("/api/cycle/period", {
        action: "start",
        date,
        loggedAt: new Date().toISOString(),
      });
    },
    onSuccess: (data, date) => {
      void invalidateKeys(qc, cycleDependentKeys);
      toastWrittenOutcome(
        "success",
        data?.absorbed
          ? t("cycle.startAbsorbed", {
              absorbed: formatDay(data.absorbed.startDate),
              date: formatDay(date),
            })
          : t("cycle.periodStartSaved"),
      );
    },
    // v1.16.4 — period boundaries had no failure signal at all (the sheet
    // simply stayed open); a toast names the rejection.
    onError: (failure) =>
      showErrorToast(t("cycle.saveError"), { cause: failure }),
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
    onError: (failure) =>
      showErrorToast(t("cycle.saveError"), { cause: failure }),
  });
}

/** Soft-delete a logged day by its row id (the GET supplies the id). */
export function useDeleteDayLog() {
  const qc = useQueryClient();
  const { t } = useTranslations();
  const restoredMessage = useRestoredStartsMessage();
  return useMutation({
    mutationFn: async (id: string) => {
      // Ask for what the delete changed: removing a start day can give back a
      // start it had folded in, and the toast names it. A server that does
      // not know the preference answers 204, read as nothing given back.
      return apiDelete<{ restored?: CycleStartRef[] } | null>(
        `/api/cycle/day-logs/${id}`,
        undefined,
        { headers: { Prefer: "return=representation" } },
      );
    },
    onSuccess: (data) => {
      void invalidateKeys(qc, cycleDependentKeys);
      toastWrittenOutcome(
        "success",
        restoredMessage(t("cycle.deleteSuccess"), data?.restored),
      );
    },
    onError: (failure) =>
      showErrorToast(t("cycle.deleteError"), { cause: failure }),
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
