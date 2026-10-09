/**
 * The remembered last day of the day layer: bound to its account and record,
 * gone at a session end, and never a reason to throw when storage refuses.
 */
import { describe, expect, it } from "vitest";

import {
  clearLastDay,
  LAST_DAY_STORAGE_KEY,
  readDayOpen,
  readLastDay,
  writeDayClosed,
  writeLastDay,
} from "../last-day";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("last day", () => {
  it("gives the day back to the account and record that opened it", () => {
    const storage = memoryStorage();
    writeLastDay("u1:own", "2026-10-05", storage);
    expect(readLastDay("u1:own", storage)).toBe("2026-10-05");
  });

  it("gives nothing to another account, another record or no session", () => {
    const storage = memoryStorage();
    writeLastDay("u1:own", "2026-10-05", storage);
    expect(readLastDay("u2:own", storage)).toBeNull();
    expect(readLastDay("u1:rec-9", storage)).toBeNull();
    expect(readLastDay(null, storage)).toBeNull();
  });

  it("is gone after a session end", () => {
    const storage = memoryStorage();
    writeLastDay("u1:own", "2026-10-05", storage);
    clearLastDay(storage);
    expect(storage.map.has(LAST_DAY_STORAGE_KEY)).toBe(false);
    expect(readLastDay("u1:own", storage)).toBeNull();
  });

  it("reads a damaged value as nothing", () => {
    const storage = memoryStorage();
    storage.setItem(LAST_DAY_STORAGE_KEY, "{not json");
    expect(readLastDay("u1:own", storage)).toBeNull();
    storage.setItem(
      LAST_DAY_STORAGE_KEY,
      JSON.stringify({ owner: "u1:own", day: "yesterday" }),
    );
    expect(readLastDay("u1:own", storage)).toBeNull();
  });

  it("never throws when storage refuses", () => {
    expect(readLastDay("u1:own", throwing)).toBeNull();
    expect(() => writeLastDay("u1:own", "2026-10-05", throwing)).not.toThrow();
    expect(() => clearLastDay(throwing)).not.toThrow();
  });
});

describe("a day left open", () => {
  it("is open once opened, and stays open until the person folds it", () => {
    const storage = memoryStorage();
    expect(readDayOpen("u1:own", storage)).toBe(false);
    writeLastDay("u1:own", "2026-10-05", storage);
    expect(readDayOpen("u1:own", storage)).toBe(true);
    writeDayClosed("u1:own", storage);
    expect(readDayOpen("u1:own", storage)).toBe(false);
    // The day itself is kept for the edge.
    expect(readLastDay("u1:own", storage)).toBe("2026-10-05");
    // Opening it again opens it again.
    writeLastDay("u1:own", "2026-10-05", storage);
    expect(readDayOpen("u1:own", storage)).toBe(true);
  });

  it("is never open for another account, an older value or a refusing store", () => {
    const storage = memoryStorage();
    writeLastDay("u1:own", "2026-10-05", storage);
    expect(readDayOpen("u2:own", storage)).toBe(false);
    storage.map.set(
      LAST_DAY_STORAGE_KEY,
      JSON.stringify({ owner: "u1:own", day: "2026-10-05" }),
    );
    expect(readDayOpen("u1:own", storage)).toBe(false);
    expect(readDayOpen("u1:own", throwing)).toBe(false);
    expect(() => writeDayClosed("u1:own", throwing)).not.toThrow();
  });
});
