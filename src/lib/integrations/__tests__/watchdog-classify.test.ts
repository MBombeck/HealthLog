import { describe, expect, it } from "vitest";
import type { ConnectionHealth } from "../connection-health";
import {
  NORMAL_DELIVERY_MIN_DAYS,
  SOURCE_PROFILES,
  classifySilence,
  FIRST_RUN_ALERTED_AT,
  currentIncident,
  decideWatchTransition,
  type WatchRow,
} from "../watchdog-classify";
import { formatWatchdogMessage } from "../watchdog";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

function health(
  state: ConnectionHealth["state"],
  reason: ConnectionHealth["reason"],
  since: Date | null,
): ConnectionHealth {
  return {
    state,
    reason,
    since: since?.toISOString() ?? null,
    action: null,
    unavailable: [],
    lastSuccessAt: null,
    lastDataAt: null,
    diagnostics: {
      ledgerState: null,
      failingLegs: [],
      failingSince: null,
      lastAttemptAt: null,
      verdict: "fresh",
      recentCalls: [],
    },
  };
}

const openRow = (overrides: Partial<WatchRow> = {}): WatchRow => ({
  silentSince: null,
  incidentReason: "unexpected_silence",
  incidentOpenedAt: ago(5),
  alertedAt: ago(5),
  ...overrides,
});

describe("classifySilence", () => {
  // A wearable whose cloud receives data on its own: the 24 h window.
  const wearable = SOURCE_PROFILES["google-health"];
  const withings = SOURCE_PROFILES.withings;

  it("never flags an on-demand source for silence, however long and however regular", () => {
    expect(withings.kind).toBe("on_demand");
    expect(SOURCE_PROFILES.strava.kind).toBe("on_demand");
    expect(
      classifySilence({
        profile: withings,
        lastDataAt: ago(24 * 30),
        deliveredDays: 14,
        currentSilentSince: null,
        now: NOW,
      }),
    ).toEqual({ kind: "clear" });
  });

  it("is clear while a continuous source delivers inside its window", () => {
    expect(
      classifySilence({
        profile: wearable,
        lastDataAt: ago(20),
        deliveredDays: null,
        currentSilentSince: null,
        now: NOW,
      }),
    ).toEqual({ kind: "clear" });
  });

  it("asks for the history before flagging (the cheap hourly pass reads it lazily)", () => {
    expect(
      classifySilence({
        profile: wearable,
        lastDataAt: ago(30),
        deliveredDays: null,
        currentSilentSince: null,
        now: NOW,
      }),
    ).toEqual({ kind: "needs_history" });
  });

  it("flags a silent source that delivered on most of the previous 14 days", () => {
    expect(
      classifySilence({
        profile: wearable,
        lastDataAt: ago(30),
        deliveredDays: NORMAL_DELIVERY_MIN_DAYS,
        currentSilentSince: null,
        now: NOW,
      }),
    ).toEqual({ kind: "flag", silentSince: ago(30) });
  });

  it("does not flag a source its owner wears only now and then", () => {
    expect(
      classifySilence({
        profile: wearable,
        lastDataAt: ago(30),
        deliveredDays: NORMAL_DELIVERY_MIN_DAYS - 1,
        currentSilentSince: null,
        now: NOW,
      }),
    ).toEqual({ kind: "not_expected" });
  });

  it("keeps a standing flag on the hourly pass without re-reading history", () => {
    expect(
      classifySilence({
        profile: wearable,
        lastDataAt: ago(50),
        deliveredDays: null,
        currentSilentSince: ago(50),
        now: NOW,
      }),
    ).toEqual({ kind: "flag", silentSince: ago(50) });
  });

  it("drops a standing flag on the daily re-check once the history no longer says it delivers", () => {
    expect(
      classifySilence({
        profile: wearable,
        lastDataAt: ago(24 * 6),
        deliveredDays: 8,
        currentSilentSince: ago(24 * 6),
        now: NOW,
      }),
    ).toEqual({ kind: "not_expected" });
  });

  it("waits 48 h for Oura and WHOOP, which upload only when their phone app is opened", () => {
    for (const key of ["oura", "whoop"] as const) {
      const profile = SOURCE_PROFILES[key];
      expect(profile.kind).toBe("continuous");
      // A day and a half without opening the app is ordinary.
      expect(
        classifySilence({
          profile,
          lastDataAt: ago(36),
          deliveredDays: 14,
          currentSilentSince: null,
          now: NOW,
        }),
      ).toEqual({ kind: "clear" });
      // Past two days it is not.
      expect(
        classifySilence({
          profile,
          lastDataAt: ago(49),
          deliveredDays: 14,
          currentSilentSince: null,
          now: NOW,
        }),
      ).toEqual({ kind: "flag", silentSince: ago(49) });
    }
  });

  it("keeps the 24 h window for wearables whose cloud receives data on its own", () => {
    for (const key of ["google-health", "polar", "nightscout"] as const) {
      expect(SOURCE_PROFILES[key]).toEqual({
        kind: "continuous",
        silenceWindowMs: 24 * HOUR,
      });
    }
  });

  it("never alerts on silence for scales, cuffs and workout logs", () => {
    for (const key of ["withings", "strava"] as const) {
      expect(SOURCE_PROFILES[key].kind).toBe("on_demand");
    }
  });

  it("gives Apple Health a wider window than a wearable", () => {
    expect(SOURCE_PROFILES["apple-health"].silenceWindowMs).toBe(48 * HOUR);
    const apple = SOURCE_PROFILES["apple-health"];
    expect(
      classifySilence({
        profile: apple,
        lastDataAt: ago(30),
        deliveredDays: 14,
        currentSilentSince: null,
        now: NOW,
      }),
    ).toEqual({ kind: "clear" });
  });
});

describe("currentIncident", () => {
  it("opens nothing for a degraded state younger than a day", () => {
    expect(
      currentIncident({
        health: health("degraded", "provider_errors", ago(5)),
        silentSince: null,
        ledgerAlerted: false,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("opens an incident once degraded or action_required has lasted more than a day", () => {
    expect(
      currentIncident({
        health: health("action_required", "reauth_required", ago(25)),
        silentSince: null,
        ledgerAlerted: false,
        now: NOW,
      }),
    ).toEqual({ reason: "reauth_required", since: ago(25) });
  });

  it("follows the ledger's own page at once, so its recovery is reported too", () => {
    expect(
      currentIncident({
        health: health("degraded", "provider_errors", ago(3)),
        silentSince: null,
        ledgerAlerted: true,
        now: NOW,
      }),
    ).toEqual({ reason: "provider_errors", since: ago(3) });
  });

  it("opens a silence incident from the flag", () => {
    expect(
      currentIncident({
        health: health("ok", "data_arriving", null),
        silentSince: ago(30),
        ledgerAlerted: false,
        now: NOW,
      }),
    ).toEqual({ reason: "unexpected_silence", since: ago(30) });
  });

  it("never opens an incident for stale or stalled data on its own, however long it lasts", () => {
    // An Apple Health account whose phone app stopped running reads as
    // `no_new_data` for good; nothing an operator can do about it.
    for (const reason of ["no_new_data", "sync_stalled"] as const) {
      expect(
        currentIncident({
          health: health("degraded", reason, ago(24 * 90)),
          silentSince: null,
          ledgerAlerted: false,
          now: NOW,
        }),
      ).toBeNull();
    }
  });

  it("opens an incident for provider errors that have lasted more than a day", () => {
    expect(
      currentIncident({
        health: health("degraded", "provider_errors", ago(25)),
        silentSince: null,
        ledgerAlerted: false,
        now: NOW,
      }),
    ).toEqual({ reason: "provider_errors", since: ago(25) });
  });

  it("still opens a silence incident beside stale data", () => {
    expect(
      currentIncident({
        health: health("degraded", "no_new_data", ago(50)),
        silentSince: ago(30),
        ledgerAlerted: false,
        now: NOW,
      }),
    ).toEqual({ reason: "unexpected_silence", since: ago(30) });
  });

  it("has no incident for a limited connection", () => {
    expect(
      currentIncident({
        health: health("limited", "plan_limited", null),
        silentSince: null,
        ledgerAlerted: false,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("decideWatchTransition: an incident recorded on the first run", () => {
  it("closes without a recovery note, since none was ever sent", () => {
    expect(
      decideWatchTransition({
        row: {
          silentSince: ago(30),
          incidentReason: "unexpected_silence",
          incidentOpenedAt: ago(2),
          alertedAt: FIRST_RUN_ALERTED_AT,
        },
        incident: null,
        ledgerAlerted: false,
      }),
    ).toEqual({
      kind: "close",
      notify: false,
      previousReason: "unexpected_silence",
    });
  });
});

describe("decideWatchTransition", () => {
  const incident = { reason: "unexpected_silence" as const, since: ago(30) };

  it("opens and announces a new incident", () => {
    expect(
      decideWatchTransition({ row: null, incident, ledgerAlerted: false }),
    ).toEqual({ kind: "open", ...incident });
  });

  it("adopts an incident the ledger already paged about instead of paging again", () => {
    expect(
      decideWatchTransition({ row: null, incident, ledgerAlerted: true }),
    ).toEqual({ kind: "adopt", ...incident });
  });

  it("sends nothing while an announced incident stays open (no repeats)", () => {
    expect(
      decideWatchTransition({
        row: openRow(),
        incident,
        ledgerAlerted: false,
      }),
    ).toEqual({ kind: "keep", reason: "unexpected_silence", announce: false });
  });

  it("treats a changed reason as the same incident", () => {
    expect(
      decideWatchTransition({
        row: openRow(),
        incident: { reason: "reauth_required", since: ago(2) },
        ledgerAlerted: false,
      }),
    ).toEqual({ kind: "keep", reason: "reauth_required", announce: false });
  });

  it("retries the announcement of an incident no channel accepted", () => {
    expect(
      decideWatchTransition({
        row: openRow({ alertedAt: null }),
        incident,
        ledgerAlerted: false,
      }),
    ).toEqual({ kind: "keep", reason: "unexpected_silence", announce: true });
  });

  it("closes with one recovery note when the announced incident ends", () => {
    expect(
      decideWatchTransition({
        row: openRow(),
        incident: null,
        ledgerAlerted: false,
      }),
    ).toEqual({
      kind: "close",
      notify: true,
      previousReason: "unexpected_silence",
    });
  });

  it("closes quietly when the operator was never told it started", () => {
    expect(
      decideWatchTransition({
        row: openRow({ alertedAt: null }),
        incident: null,
        ledgerAlerted: false,
      }),
    ).toEqual({
      kind: "close",
      notify: false,
      previousReason: "unexpected_silence",
    });
  });

  it("does nothing when there was and is no incident", () => {
    expect(
      decideWatchTransition({
        row: null,
        incident: null,
        ledgerAlerted: false,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("formatWatchdogMessage", () => {
  it("names the provider, the account and the instant, in plain text", () => {
    const m = formatWatchdogMessage({
      kind: "incident",
      key: "oura",
      subjectLabel: "someone@example.test",
      reason: "unexpected_silence",
      since: ago(30),
    });
    expect(m.title).toBe("Oura needs attention for someone@example.test");
    expect(m.message).toContain("2026-10-14 06:00 UTC");
    expect(m.message).not.toMatch(/[—–·→]/);
  });

  it("says why a recovered incident ended", () => {
    const m = formatWatchdogMessage({
      kind: "recovery",
      key: "apple-health",
      subjectLabel: "someone@example.test",
      reason: "unexpected_silence",
      since: null,
      closedBecause: "disconnected",
    });
    expect(m.title).toBe("Apple Health recovered for someone@example.test");
    expect(m.message).toContain("removed");
  });
});
