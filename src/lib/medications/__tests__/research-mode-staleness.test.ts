import { describe, it, expect } from "vitest";

import {
  RESEARCH_MODE_ACK_MAX_AGE_DAYS,
  isAcknowledgmentStale,
} from "../research-mode-staleness";

/**
 * v1.4.25 W19c-Safety — 90-day staleness gate unit tests.
 *
 * The helper is pure (no I/O, no Date.now()) so every test pins both
 * `acknowledgedAt` and `asOf` explicitly. The threshold is exclusive:
 * day 90 is still inside the window, day 91 falls out.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ASOF = new Date("2026-05-14T12:00:00Z");

function daysAgo(n: number): Date {
  return new Date(ASOF.getTime() - n * MS_PER_DAY);
}

describe("RESEARCH_MODE_ACK_MAX_AGE_DAYS", () => {
  it("defaults to 90 days", () => {
    expect(RESEARCH_MODE_ACK_MAX_AGE_DAYS).toBe(90);
  });
});

describe("isAcknowledgmentStale — null and invalid inputs", () => {
  it("null acknowledgment is stale", () => {
    expect(isAcknowledgmentStale(null, ASOF)).toBe(true);
  });

  it("non-finite acknowledgedAt is stale", () => {
    expect(isAcknowledgmentStale(new Date(NaN), ASOF)).toBe(true);
  });

  it("non-finite asOf is stale (defensive — caller should never pass NaN)", () => {
    expect(isAcknowledgmentStale(daysAgo(1), new Date(NaN))).toBe(true);
  });
});

describe("isAcknowledgmentStale — within window", () => {
  it("acknowledgment today is fresh", () => {
    expect(isAcknowledgmentStale(ASOF, ASOF)).toBe(false);
  });

  it("acknowledgment 1 day ago is fresh", () => {
    expect(isAcknowledgmentStale(daysAgo(1), ASOF)).toBe(false);
  });

  it("acknowledgment 30 days ago is fresh", () => {
    expect(isAcknowledgmentStale(daysAgo(30), ASOF)).toBe(false);
  });

  it("acknowledgment 89 days ago is fresh", () => {
    expect(isAcknowledgmentStale(daysAgo(89), ASOF)).toBe(false);
  });

  it("acknowledgment exactly 90 days ago is still fresh (threshold is exclusive)", () => {
    expect(isAcknowledgmentStale(daysAgo(90), ASOF)).toBe(false);
  });
});

describe("isAcknowledgmentStale — outside window", () => {
  it("acknowledgment 91 days ago is stale", () => {
    expect(isAcknowledgmentStale(daysAgo(91), ASOF)).toBe(true);
  });

  it("acknowledgment 180 days ago is stale", () => {
    expect(isAcknowledgmentStale(daysAgo(180), ASOF)).toBe(true);
  });

  it("acknowledgment 365 days ago is stale", () => {
    expect(isAcknowledgmentStale(daysAgo(365), ASOF)).toBe(true);
  });
});

describe("isAcknowledgmentStale — custom maxAgeDays", () => {
  it("respects a 30-day override", () => {
    expect(isAcknowledgmentStale(daysAgo(29), ASOF, 30)).toBe(false);
    expect(isAcknowledgmentStale(daysAgo(30), ASOF, 30)).toBe(false);
    expect(isAcknowledgmentStale(daysAgo(31), ASOF, 30)).toBe(true);
  });

  it("respects a 365-day override", () => {
    expect(isAcknowledgmentStale(daysAgo(180), ASOF, 365)).toBe(false);
    expect(isAcknowledgmentStale(daysAgo(366), ASOF, 365)).toBe(true);
  });

  it("treats zero or negative maxAgeDays as stale (defensive)", () => {
    expect(isAcknowledgmentStale(daysAgo(1), ASOF, 0)).toBe(true);
    expect(isAcknowledgmentStale(daysAgo(1), ASOF, -10)).toBe(true);
  });

  it("treats non-finite maxAgeDays as stale (defensive)", () => {
    expect(isAcknowledgmentStale(daysAgo(1), ASOF, NaN)).toBe(true);
    expect(isAcknowledgmentStale(daysAgo(1), ASOF, Infinity)).toBe(true);
  });
});

describe("isAcknowledgmentStale — clock-skew defence", () => {
  it("acknowledgment in the future relative to asOf is treated as fresh", () => {
    const future = new Date(ASOF.getTime() + 5 * MS_PER_DAY);
    expect(isAcknowledgmentStale(future, ASOF)).toBe(false);
  });

  it("acknowledgment one millisecond ahead is treated as fresh", () => {
    const slightlyAhead = new Date(ASOF.getTime() + 1);
    expect(isAcknowledgmentStale(slightlyAhead, ASOF)).toBe(false);
  });
});
