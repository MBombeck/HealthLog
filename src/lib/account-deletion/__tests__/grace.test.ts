import { afterEach, describe, expect, it, vi } from "vitest";

import {
  accountDeletionGraceDays,
  accountDeletionPurgeAt,
  preWipeCopyCutoff,
} from "../grace";

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("accountDeletionGraceDays", () => {
  it("is 14 days when unset or blank", () => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "");
    expect(accountDeletionGraceDays()).toBe(14);
  });

  it("reads a whole number of days, 0 included", () => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "7");
    expect(accountDeletionGraceDays()).toBe(7);
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", " 0 ");
    expect(accountDeletionGraceDays()).toBe(0);
  });

  it("clamps past 30 days rather than obeying", () => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "365");
    expect(accountDeletionGraceDays()).toBe(30);
  });

  it("falls back to the default on anything that is not a whole number", () => {
    for (const raw of ["-1", "1.5", "two", "14d"]) {
      vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", raw);
      expect(accountDeletionGraceDays()).toBe(14);
    }
  });
});

describe("the dates the window gives", () => {
  const at = new Date("2026-10-25T10:00:00.000Z");

  it("erases the window's length after the request, or now", () => {
    expect(accountDeletionPurgeAt(at, 14)?.getTime()).toBe(
      at.getTime() + 14 * DAY_MS,
    );
    expect(accountDeletionPurgeAt(at, 0)).toBeNull();
  });

  it("keeps a pre-wipe copy for the window and no longer", () => {
    expect(preWipeCopyCutoff(at, 14).getTime()).toBe(
      at.getTime() - 14 * DAY_MS,
    );
    expect(preWipeCopyCutoff(at, 0).getTime()).toBe(at.getTime());
  });
});
