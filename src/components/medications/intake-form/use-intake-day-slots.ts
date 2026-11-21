"use client";

/**
 * The slots the intake form may offer, read from the server's dose ledger
 * for the local day of the chosen time in the account's zone. The ledger is
 * the same read model the server's slot check is built from, so a slot shown
 * here is one the write accepts; the form computes no cadence of its own.
 *
 * The read is keyed by the day, so moving the time within a day reuses it
 * and moving it to another day reads that day. Until the day's answer is in,
 * no slot is offered (`loading`); when the read fails, none is either
 * (`error`), and the dose records as an extra one.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";

import {
  openSlotsOf,
  type DayLedgerRow,
  type DaySlot,
} from "./slot-attribution";

export type DaySlotsStatus = "loading" | "error" | "ready";

const NO_SLOTS: DaySlot[] = [];

export function useIntakeDaySlots({
  medicationId,
  takenAtLocal,
}: {
  medicationId: string | undefined;
  takenAtLocal: string;
}): { status: DaySlotsStatus; slots: DaySlot[] } {
  const { user } = useAuth();
  const timeZone = user?.timezone || DEFAULT_TIMEZONE;
  const taken = new Date(takenAtLocal);
  const dayKey = Number.isNaN(taken.getTime())
    ? null
    : userDayKey(taken, timeZone);
  const window = useMemo(
    () => (dayKey ? localDayWindow(dayKey, timeZone) : null),
    [dayKey, timeZone],
  );

  const query = useQuery({
    queryKey: queryKeys.medicationDoseHistoryDay(
      medicationId ?? "",
      dayKey ?? "",
      timeZone,
    ),
    enabled: Boolean(medicationId && window),
    queryFn: async () => {
      if (!medicationId || !window) return { rows: [] };
      // `to` is inclusive on the server; stop a millisecond before the next
      // day so its midnight slot stays out.
      const search = new URLSearchParams({
        from: window.dayStart.toISOString(),
        to: new Date(window.dayEnd.getTime() - 1).toISOString(),
      });
      return apiGet<{ rows: DayLedgerRow[] }>(
        `/api/medications/${medicationId}/dose-history?${search.toString()}`,
      );
    },
    staleTime: 15_000,
  });

  const slots = useMemo(
    () =>
      query.data && window ? openSlotsOf(query.data.rows, window) : NO_SLOTS,
    [query.data, window],
  );

  if (!medicationId || !window) return { status: "ready", slots: NO_SLOTS };
  if (query.isError) return { status: "error", slots: NO_SLOTS };
  if (!query.data) return { status: "loading", slots: NO_SLOTS };
  return { status: "ready", slots };
}
