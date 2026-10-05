import { describe, expect, it } from "vitest";

import {
  COACH_PANEL_STORAGE_KEY,
  readCoachPanelPreference,
  resolveCoachPanelOpen,
  writeCoachPanelPreference,
} from "../use-coach-panel-open";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("coach panel open preference", () => {
  it("opens the docked panel on a first visit", () => {
    const storage = memoryStorage();
    expect(readCoachPanelPreference(storage)).toBeNull();
    expect(resolveCoachPanelOpen(readCoachPanelPreference(storage))).toBe(true);
  });

  it("remembers a closed panel, and an opened one, across reads", () => {
    const storage = memoryStorage();
    expect(writeCoachPanelPreference(storage, false)).toBe(true);
    expect(storage.map.get(COACH_PANEL_STORAGE_KEY)).toBe("false");
    expect(resolveCoachPanelOpen(readCoachPanelPreference(storage))).toBe(
      false,
    );
    writeCoachPanelPreference(storage, true);
    expect(resolveCoachPanelOpen(readCoachPanelPreference(storage))).toBe(true);
  });

  it("treats an unknown stored value as no choice", () => {
    const storage = memoryStorage({ [COACH_PANEL_STORAGE_KEY]: "maybe" });
    expect(readCoachPanelPreference(storage)).toBeNull();
  });

  it("falls back to the default when storage throws or is absent", () => {
    expect(readCoachPanelPreference(throwing)).toBeNull();
    expect(writeCoachPanelPreference(throwing, false)).toBe(false);
    expect(readCoachPanelPreference(null)).toBeNull();
    expect(writeCoachPanelPreference(undefined, true)).toBe(false);
  });
});
