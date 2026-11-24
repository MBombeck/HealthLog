import { afterEach, describe, expect, it, vi } from "vitest";

import {
  capAtRefreshFamilyEnd,
  readDays,
  REFRESH_TOKEN_MAX_LIFETIME,
  refreshFamilyHardEnd,
  secondsUntil,
  SESSION_IDLE_TIMEOUT,
  SESSION_MAX_LIFETIME,
  webSessionExpiry,
  webSessionHardEnd,
} from "../session-lifetime";

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  delete process.env.SESSION_IDLE_TIMEOUT_DAYS;
  delete process.env.SESSION_MAX_LIFETIME_DAYS;
  delete process.env.REFRESH_TOKEN_MAX_LIFETIME_DAYS;
  vi.restoreAllMocks();
});

describe("readDays", () => {
  it("answers the defaults when nothing is set", () => {
    expect(readDays(SESSION_IDLE_TIMEOUT, {})).toBe(30);
    expect(readDays(SESSION_MAX_LIFETIME, {})).toBe(90);
    expect(readDays(REFRESH_TOKEN_MAX_LIFETIME, {})).toBe(180);
  });

  it("takes a whole number inside the bounds", () => {
    expect(
      readDays(SESSION_MAX_LIFETIME, { SESSION_MAX_LIFETIME_DAYS: " 14 " }),
    ).toBe(14);
    expect(
      readDays(SESSION_IDLE_TIMEOUT, { SESSION_IDLE_TIMEOUT_DAYS: "1" }),
    ).toBe(1);
  });

  it.each(["0", "-5", "7.5", "1e2", "ninety", "366"])(
    "keeps the default for %j instead of guessing, and says so",
    (raw) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(
        readDays(
          { ...SESSION_MAX_LIFETIME, name: `TEST_DAYS_${raw}` },
          { [`TEST_DAYS_${raw}`]: raw },
        ),
      ).toBe(90);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe("web session clocks", () => {
  it("slides the idle window but never past the end counted from the sign-in", () => {
    const signedIn = new Date("2027-01-01T00:00:00Z");
    expect(webSessionHardEnd(signedIn).getTime()).toBe(
      signedIn.getTime() + 90 * DAY_MS,
    );

    const early = new Date(signedIn.getTime() + 10 * DAY_MS);
    expect(webSessionExpiry(signedIn, early).getTime()).toBe(
      early.getTime() + 30 * DAY_MS,
    );

    const late = new Date(signedIn.getTime() + 80 * DAY_MS);
    expect(webSessionExpiry(signedIn, late).getTime()).toBe(
      signedIn.getTime() + 90 * DAY_MS,
    );
  });

  it("lets an absolute lifetime shorter than the idle window win", () => {
    process.env.SESSION_MAX_LIFETIME_DAYS = "3";
    const signedIn = new Date("2027-01-01T00:00:00Z");
    expect(webSessionExpiry(signedIn, signedIn).getTime()).toBe(
      signedIn.getTime() + 3 * DAY_MS,
    );
  });
});

describe("refresh family clocks", () => {
  it("caps an instant at the family's end", () => {
    const started = new Date("2027-01-01T00:00:00Z");
    const end = refreshFamilyHardEnd(started);
    expect(end.getTime()).toBe(started.getTime() + 180 * DAY_MS);

    const before = new Date(end.getTime() - DAY_MS);
    expect(capAtRefreshFamilyEnd(before, started)).toBe(before);
    expect(
      capAtRefreshFamilyEnd(new Date(end.getTime() + DAY_MS), started),
    ).toEqual(end);
  });

  it("follows REFRESH_TOKEN_MAX_LIFETIME_DAYS", () => {
    process.env.REFRESH_TOKEN_MAX_LIFETIME_DAYS = "30";
    const started = new Date("2027-01-01T00:00:00Z");
    expect(refreshFamilyHardEnd(started).getTime()).toBe(
      started.getTime() + 30 * DAY_MS,
    );
  });
});

describe("secondsUntil", () => {
  it("never answers a negative Max-Age", () => {
    expect(secondsUntil(new Date(1_000), 5_000)).toBe(0);
    expect(secondsUntil(new Date(65_500), 5_000)).toBe(60);
  });
});
