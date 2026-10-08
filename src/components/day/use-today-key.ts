"use client";

import { useDisplayTimezone } from "@/lib/i18n/context";
import type { DateKey } from "@/lib/day/contract";

import { todayKeyInZone } from "./day-url";

/**
 * Today in the record's display zone. A day after this one has nothing to
 * show, so no surface links to it and the layer refuses it.
 */
export function useTodayKey(): DateKey {
  const timeZone = useDisplayTimezone();
  return todayKeyInZone(timeZone);
}
