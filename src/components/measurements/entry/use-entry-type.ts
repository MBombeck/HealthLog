"use client";

import { useState } from "react";

import { useRecentEntryTypes } from "./use-entry-recall";

/**
 * The add form's measurement type. A deep-link default wins, else the type
 * the person last saved by hand, read from their own readings (the same
 * answer on every device, and nothing about their health kept in browser
 * storage), else blood pressure. A type that is not offered (its module is
 * off) falls back to the first offered one.
 *
 * Once `started` (something is typed), the shown type stays put: the readings
 * that pick the default may arrive after the first keystroke. `setType(null)`
 * returns to the default.
 */
export function useEntryType(
  offered: ReadonlyArray<string>,
  deepLink: string | null | undefined,
  started: boolean,
): { type: string; setType: (type: string | null) => void } {
  const recent = useRecentEntryTypes(offered, true);
  const [picked, setType] = useState<string | null>(deepLink || null);
  const selected = picked ?? recent[0] ?? "BLOOD_PRESSURE";
  const type = offered.includes(selected)
    ? selected
    : (offered[0] ?? "BLOOD_PRESSURE");
  if (picked === null && started) setType(type);
  return { type, setType };
}
