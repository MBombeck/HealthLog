/**
 * The sync-health ladder.
 *
 * The load-bearing row is `stalled`. A ledger frozen at `error_transient` with
 * a month-old `lastAttemptAt` used to be indistinguishable from one retrying
 * every hour, because nothing anywhere read the age of that timestamp. The
 * fixture below is the live incident that exposed it: an integration that had
 * not even TRIED for four weeks while claiming, in its own documented contract,
 * that it "still attempts on the next run".
 */
import { describe, expect, it } from "vitest";

import {
  APPLE_HEALTH_DATA_STALE_AFTER_MS,
  ATTEMPT_STALE_AFTER_MS,
  INTEGRATION_CADENCE,
  POLLED_CADENCE,
  PUSH_CADENCE,
  resolveSyncVerdict,
} from "../sync-verdict";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const nowMs = NOW.getTime();
const ago = (ms: number) => new Date(nowMs - ms).toISOString();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("resolveSyncVerdict — the ladder", () => {
  it("calls a month-silent polled integration stalled, not failing", () => {
    // The live incident: state frozen at error_transient since the last write,
    // no attempt for four weeks, hourly cron cohort.
    const lastAttemptAt = ago(28 * DAY);
    const result = resolveSyncVerdict({
      configured: true,
      state: "error_transient",
      lastSuccessAt: ago(55 * DAY),
      lastAttemptAt,
      cadence: INTEGRATION_CADENCE.nightscout,
      now: NOW,
    });
    expect(result.verdict).toBe("stalled");
    expect(result.since).toBe(lastAttemptAt);
  });

  it("calls a recently-attempted failing integration failing", () => {
    const lastSuccessAt = ago(3 * DAY);
    expect(
      resolveSyncVerdict({
        connected: true,
        state: "error_transient",
        lastSuccessAt,
        lastAttemptAt: ago(2 * HOUR),
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "failing", since: lastSuccessAt });
  });

  it("draws the stalled line at 24 hours", () => {
    // The threshold is a decision, not an implementation detail: ~24 missed
    // hourly ticks, tolerant of a maintenance window, short enough that a
    // stopped sync surfaces the next day.
    expect(ATTEMPT_STALE_AFTER_MS).toBe(24 * HOUR);

    const base = {
      connected: true,
      state: "connected",
      lastSuccessAt: null,
      cadence: POLLED_CADENCE,
      now: NOW,
    };
    expect(
      resolveSyncVerdict({ ...base, lastAttemptAt: ago(23 * HOUR) }).verdict,
    ).toBe("fresh");
    expect(
      resolveSyncVerdict({ ...base, lastAttemptAt: ago(25 * HOUR) }).verdict,
    ).toBe("stalled");
  });

  it("never calls a push source stalled — it has no attempt concept", () => {
    // Same 28-day silence, push cadence: the honest reading is 'no data', not
    // 'stopped trying', because nothing was ever going to try.
    const lastSyncedAt = ago(28 * DAY);
    expect(
      resolveSyncVerdict({
        configured: true,
        lastDataAt: lastSyncedAt,
        legacyLastSyncedAt: lastSyncedAt,
        cadence: PUSH_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "stale", since: lastSyncedAt });
  });

  it("draws the Apple Health line at seven days", () => {
    // Long enough not to false-alarm on a normal iOS background-delivery gap,
    // short enough that a genuinely dead pipe is named within a week.
    expect(APPLE_HEALTH_DATA_STALE_AFTER_MS).toBe(7 * DAY);

    const base = { configured: true, cadence: PUSH_CADENCE, now: NOW };
    expect(
      resolveSyncVerdict({ ...base, lastDataAt: ago(6 * DAY) }).verdict,
    ).toBe("fresh");
    expect(
      resolveSyncVerdict({ ...base, lastDataAt: ago(8 * DAY) }).verdict,
    ).toBe("stale");
  });

  it("reports a never-attempted connection as pending, not connected", () => {
    expect(
      resolveSyncVerdict({
        connected: true,
        configured: true,
        // The synthetic "connected, never attempted" ledger snapshot.
        state: "connected",
        lastSuccessAt: null,
        lastAttemptAt: null,
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "pending_first_sync", since: null });
  });

  it("puts parked and reauth ahead of every age-based arm", () => {
    const lastAttemptAt = ago(40 * DAY);
    expect(
      resolveSyncVerdict({
        connected: true,
        state: "parked",
        lastAttemptAt,
        lastSuccessAt: ago(60 * DAY),
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "parked", since: lastAttemptAt });
    expect(
      resolveSyncVerdict({
        connected: true,
        state: "error_reauth",
        lastAttemptAt,
        lastSuccessAt: ago(60 * DAY),
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "reauth_required", since: lastAttemptAt });
  });

  it("keeps a deliberate disconnect out of the aging arms", () => {
    // Credentials survive a disconnect. Without this arm the row would age into
    // 'stalled' and tell the user their sync had stopped, when they stopped it.
    expect(
      resolveSyncVerdict({
        connected: false,
        configured: true,
        state: "disconnected",
        lastSuccessAt: ago(90 * DAY),
        lastAttemptAt: ago(90 * DAY),
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "disconnected", since: null });
  });

  it("reports an unconfigured, unconnected provider as disconnected", () => {
    expect(
      resolveSyncVerdict({
        configured: false,
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "disconnected", since: null });
  });

  it("falls back to the data-age arm for a polled source that keeps trying", () => {
    // Defensive arm: attempts are current, but nothing new has landed.
    const lastSuccessAt = ago(5 * DAY);
    expect(
      resolveSyncVerdict({
        connected: true,
        state: "connected",
        lastSuccessAt,
        lastAttemptAt: ago(30 * 60 * 1000),
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "stale", since: lastSuccessAt });
  });

  it("calls a healthy hourly integration fresh", () => {
    expect(
      resolveSyncVerdict({
        connected: true,
        state: "connected",
        lastSuccessAt: ago(20 * 60 * 1000),
        lastAttemptAt: ago(20 * 60 * 1000),
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "fresh", since: null });
  });

  it("puts every hourly ledger-backed integration on the polled cadence", () => {
    for (const [key, cadence] of Object.entries(INTEGRATION_CADENCE)) {
      // Dawarich runs once a night and the Health Connect folder every six
      // hours with a backoff to a day; either is overdue after two days.
      const expected =
        key === "dawarich" || key === "health-connect-remote"
          ? 48 * HOUR
          : 24 * HOUR;
      expect(cadence.attemptStaleAfterMs, key).toBe(expected);
    }
  });
});

describe("resolveSyncVerdict — the error verdicts date the streak", () => {
  it("dates a failing provider from the streak start, not the last retry", () => {
    // The shape that hid a fortnight of silence: the hourly retry keeps
    // `lastAttemptAt` fresh, and a multi-leg provider can keep advancing
    // `lastSuccessAt` from a healthy leg while another one is dead.
    const failingSinceAt = ago(17 * DAY);
    expect(
      resolveSyncVerdict({
        connected: true,
        state: "error_transient",
        lastSuccessAt: ago(30 * MINUTE),
        lastAttemptAt: ago(4 * MINUTE),
        failingSinceAt,
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "failing", since: failingSinceAt });
  });

  it("falls back to the last success when the ledger has no streak anchor", () => {
    // Rows written before the anchor existed, and never re-failed since.
    const lastSuccessAt = ago(3 * DAY);
    expect(
      resolveSyncVerdict({
        connected: true,
        state: "error_transient",
        lastSuccessAt,
        lastAttemptAt: ago(2 * HOUR),
        failingSinceAt: null,
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "failing", since: lastSuccessAt });
  });

  it("dates a parked provider from the streak start", () => {
    const failingSinceAt = ago(6 * DAY);
    expect(
      resolveSyncVerdict({
        connected: true,
        state: "parked",
        lastAttemptAt: ago(10 * MINUTE),
        failingSinceAt,
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "parked", since: failingSinceAt });
  });

  it("dates a reauth-required provider from the streak start", () => {
    const failingSinceAt = ago(9 * DAY);
    expect(
      resolveSyncVerdict({
        connected: true,
        state: "error_reauth",
        lastAttemptAt: ago(10 * MINUTE),
        failingSinceAt,
        cadence: POLLED_CADENCE,
        now: NOW,
      }),
    ).toEqual({ verdict: "reauth_required", since: failingSinceAt });
  });
});
