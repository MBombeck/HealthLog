"use client";

/**
 * A small preference kept on this device only (v1.42, #613): which value
 * lines run under the chart, which lanes are hidden, whether the readiness
 * card was closed. Conveniences, never record state: storage can be empty,
 * blocked or throw, and the timeline then simply starts from its defaults.
 */
import { useCallback, useState } from "react";

export function readDevicePreference<T>(
  key: string,
  fallback: T,
  accept: (raw: unknown) => raw is T,
): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return accept(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function useDevicePreference<T>(
  key: string,
  fallback: T,
  accept: (raw: unknown) => raw is T,
): [T, (next: T) => void] {
  // Read once, on the client: the timeline mounts only after the account
  // resolved, so there is no server render of it to disagree with.
  const [value, setValue] = useState<T>(() =>
    typeof window === "undefined"
      ? fallback
      : readDevicePreference(key, fallback, accept),
  );
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage unavailable: the choice holds for this visit only.
      }
    },
    [key],
  );
  return [value, update];
}

export const isStringArray = (raw: unknown): raw is string[] =>
  Array.isArray(raw) && raw.every((v) => typeof v === "string");

export const isBoolean = (raw: unknown): raw is boolean =>
  typeof raw === "boolean";
