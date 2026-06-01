/**
 * v1.5.0 — legacy → v1.5 cadence bridge.
 *
 * Helpers that infer a `CadencePicker` initial value from the legacy
 * `(daysOfWeek, intervalWeeks)` pair the pre-v1.5 form stored, and
 * convert weekday indexes (0-6, Sunday-anchored) into the RFC 5545
 * BYDAY tokens the picker emits. Used by the edit-only path of
 * `medication-form.tsx` so a pre-v1.5 medication opens with the
 * correct picker selection and the form can dual-write both shapes
 * during the v1.5.x migration window.
 *
 * Pure functions only — no React, no DOM — so the unit tests can pin
 * the mapping table without spinning up a render tree.
 */
import { encodeCadence } from "./CadencePicker";
import {
  type CadenceSubControls,
  type CadenceValue,
  DEFAULT_SUB_CONTROLS,
  type WeekdayToken,
  WEEKDAY_TOKENS,
} from "./types";

/**
 * Legacy schedule shape the page passes to the form. Sunday-anchored
 * weekday indexes (0 = Sun, 1 = Mon, …, 6 = Sat) — that's the
 * convention `parseScheduleRecurrence` produces and the form has
 * historically stored.
 */
export interface LegacyScheduleSnapshot {
  daysOfWeek: number[];
  intervalWeeks: number;
}

/**
 * Convert a 0-6 (Sunday-anchored) weekday index to the RFC 5545
 * BYDAY token. Returns null for out-of-range input so the caller can
 * filter cleanly.
 */
export function weekdayIndexToToken(index: number): WeekdayToken | null {
  // Sunday-anchored input → BYDAY uses Monday as the first day of the
  // week (Mo Tu We Th Fr Sa Su). Map index 0 (Sun) to "SU" and 1..6 to
  // MO..SA in order.
  switch (index) {
    case 0:
      return "SU";
    case 1:
      return "MO";
    case 2:
      return "TU";
    case 3:
      return "WE";
    case 4:
      return "TH";
    case 5:
      return "FR";
    case 6:
      return "SA";
    default:
      return null;
  }
}

/**
 * Convert a list of legacy weekday indexes (0-6) to BYDAY tokens.
 * Order follows the WEEKDAY_TOKENS canonical layout so the encoded
 * RRULE matches the picker's own output for the same selection.
 */
export function weekdayIndexesToTokens(indexes: number[]): WeekdayToken[] {
  const tokens = new Set<WeekdayToken>();
  for (const idx of indexes) {
    const tok = weekdayIndexToToken(idx);
    if (tok) tokens.add(tok);
  }
  return WEEKDAY_TOKENS.filter((w) => tokens.has(w));
}

/**
 * Infer a `CadenceValue` + matching sub-controls from a pre-v1.5
 * schedule. Mapping per design-synthesis section "Edit flow — flat
 * form":
 *
 *   daysOfWeek empty AND intervalWeeks === 1 → daily
 *   daysOfWeek non-empty AND intervalWeeks === 1 → weekdays
 *   daysOfWeek non-empty AND intervalWeeks > 1 → everyNWeeks
 *   anything else (defensive fallback) → daily
 *
 * `everyNWeeks` with an empty weekday list keeps the picker valid by
 * defaulting to Monday (the same default the picker uses when its
 * own sub-control is empty). The fallback branch covers pathological
 * inputs (negative intervalWeeks, NaN, etc.) without throwing.
 */
export function inferCadenceFromLegacy(
  schedule: LegacyScheduleSnapshot,
): { value: CadenceValue; subControls: CadenceSubControls } {
  const tokens = weekdayIndexesToTokens(schedule.daysOfWeek ?? []);
  const interval = Number.isFinite(schedule.intervalWeeks)
    ? Math.trunc(schedule.intervalWeeks)
    : 1;

  // Daily — no weekday restriction, interval == 1.
  if (tokens.length === 0 && interval === 1) {
    const sub: CadenceSubControls = { ...DEFAULT_SUB_CONTROLS };
    return { value: encodeCadence("daily", sub), subControls: sub };
  }

  // Weekdays — explicit weekday list, interval == 1.
  if (tokens.length > 0 && interval === 1) {
    const sub: CadenceSubControls = {
      ...DEFAULT_SUB_CONTROLS,
      weekdays: tokens,
    };
    return { value: encodeCadence("weekdays", sub), subControls: sub };
  }

  // EveryNWeeks — explicit weekday list, interval > 1.
  if (tokens.length > 0 && interval > 1) {
    const sub: CadenceSubControls = {
      ...DEFAULT_SUB_CONTROLS,
      weekdays: tokens,
      intervalWeeks: interval,
    };
    return { value: encodeCadence("everyNWeeks", sub), subControls: sub };
  }

  // Safe fallback — surface the schedule as daily so the user can
  // pick a real cadence before saving.
  const sub: CadenceSubControls = { ...DEFAULT_SUB_CONTROLS };
  return { value: encodeCadence("daily", sub), subControls: sub };
}

/**
 * Convert the picker's BYDAY tokens back to the legacy 0-6 weekday
 * indexes (Sunday-anchored) the form sends as the `daysOfWeek` field
 * on the schedule body. Used during the v1.5.x dual-write window so
 * the route can still serialise the legacy `daysOfWeek` string column.
 */
export function tokensToWeekdayIndexes(tokens: WeekdayToken[]): number[] {
  const out: number[] = [];
  for (const tok of tokens) {
    switch (tok) {
      case "SU":
        out.push(0);
        break;
      case "MO":
        out.push(1);
        break;
      case "TU":
        out.push(2);
        break;
      case "WE":
        out.push(3);
        break;
      case "TH":
        out.push(4);
        break;
      case "FR":
        out.push(5);
        break;
      case "SA":
        out.push(6);
        break;
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * v1.5.x dual-write helper — derives the legacy `(daysOfWeek,
 * intervalWeeks)` pair the route still persists from a `CadenceValue`.
 * Returns the safe defaults for any non-calendar cadence so the
 * legacy column accepts the row even when the user picked a rolling
 * or one-shot schedule.
 */
export function legacyPairFromCadence(
  value: CadenceValue,
  subControls: CadenceSubControls,
): { daysOfWeek: number[]; intervalWeeks: number } {
  switch (value.kind) {
    case "weekdays":
      return {
        daysOfWeek: tokensToWeekdayIndexes(subControls.weekdays),
        intervalWeeks: 1,
      };
    case "everyNWeeks": {
      // The legacy `intervalWeeks` column caps at 4 — anything higher
      // is preserved on the new `rrule` field; the legacy mirror is
      // clamped so the route's `serializeScheduleRecurrence` accepts
      // the value without dropping the row.
      const clamped = Math.min(4, Math.max(1, subControls.intervalWeeks));
      return {
        daysOfWeek: tokensToWeekdayIndexes(subControls.weekdays),
        intervalWeeks: clamped,
      };
    }
    default:
      // daily / monthly / everyNMonths / yearly / rolling / oneShot —
      // none map cleanly to the legacy pair; emit "every day" as the
      // most permissive fallback so the legacy reader never silently
      // filters the row out.
      return { daysOfWeek: [], intervalWeeks: 1 };
  }
}
