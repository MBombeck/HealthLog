/**
 * Small display helpers of the seizure diary (#1368), shared by the quick
 * log, the list and the sheets.
 */
import {
  ilae2017LabelKey,
  ilaeLabelKey,
  type SeizureIlaeType,
} from "@/lib/seizures/ilae";
import type { SeizureTypeDTO } from "@/lib/seizures/shared";

type T = (key: string, params?: Record<string, string | number>) => string;

/** "1:05" under an hour, "1:02:05" above; for a ticking timer and a list. */
export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** The family's name for a type, with a stand-in for an unreadable one. */
export function typeName(type: SeizureTypeDTO | undefined, t: T): string {
  if (!type) return t("seizures.untyped");
  return type.label ?? t("seizures.type.unreadable");
}

/** "Focal aware seizure" style secondary line: 2025 name, 2017 synonym. */
export function ilaeLine(type: SeizureIlaeType, t: T): string {
  const legacy = ilae2017LabelKey(type);
  const current = t(ilaeLabelKey(type));
  if (!legacy) return current;
  const old = t(legacy);
  return old === current
    ? current
    : t("seizures.ilaeWith2017", { current, legacy: old });
}

/** A local wall-clock value for `DateTimeField` from an ISO instant. */
export function toLocalValue(iso: string): string {
  const at = new Date(iso);
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function nowLocalValue(): string {
  return toLocalValue(new Date().toISOString());
}
