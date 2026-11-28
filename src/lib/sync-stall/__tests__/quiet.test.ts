import { describe, expect, it } from "vitest";

import type { ConnectionHealth } from "@/lib/integrations/connection-health";

import { silenceStands } from "../cadence";
import {
  iphoneDelivers,
  quietSinceDate,
  resolveQuietSources,
  type QuietConnectionFacts,
} from "../quiet";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-20T10:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function health(over: Partial<ConnectionHealth> = {}): ConnectionHealth {
  return {
    state: "degraded",
    reason: "unexpected_silence",
    since: null,
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
    ...over,
  };
}

function oura(over: Partial<QuietConnectionFacts> = {}): QuietConnectionFacts {
  return {
    key: "oura",
    silentSince: ago(4 * DAY),
    lastDataAt: ago(4 * DAY),
    health: health(),
    ...over,
  };
}

describe("silenceStands", () => {
  it("holds a flag until data newer than the floor arrives", () => {
    const base = { silentSince: ago(3 * DAY), floorMs: 2 * DAY, now: NOW };
    expect(silenceStands({ ...base, lastDataAt: ago(3 * DAY) })).toBe(true);
    expect(silenceStands({ ...base, lastDataAt: ago(HOUR) })).toBe(false);
    expect(silenceStands({ ...base, lastDataAt: null })).toBe(true);
    expect(
      silenceStands({ ...base, silentSince: null, lastDataAt: null }),
    ).toBe(false);
  });
});

describe("resolveQuietSources", () => {
  it("leaves out a source whose only module is off", () => {
    const nightscout = oura({ key: "nightscout" });
    const read = (modules?: { glucose: boolean }) =>
      resolveQuietSources({
        connections: [nightscout, oura()],
        iphones: [],
        now: NOW,
        modules,
      }).map((q) => q.source);
    expect(read({ glucose: false })).toEqual(["oura"]);
    expect(read({ glucose: true })).toEqual(["oura", "nightscout"]);
    expect(read()).toEqual(["oura", "nightscout"]);
  });

  it("names a stamped connection whose silence still stands", () => {
    expect(
      resolveQuietSources({ connections: [oura()], iphones: [], now: NOW }),
    ).toEqual([{ source: "oura", since: ago(4 * DAY) }]);
  });

  it("drops a stamp the next delivery has already answered", () => {
    expect(
      resolveQuietSources({
        connections: [oura({ lastDataAt: ago(HOUR) })],
        iphones: [],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("leaves a connection that asks for a reconnect, or whose provider errors, to its own state", () => {
    const connections = [
      oura({
        health: health({ state: "action_required", reason: "reauth_required" }),
      }),
      oura({ key: "whoop", health: health({ reason: "provider_errors" }) }),
    ];
    expect(resolveQuietSources({ connections, iphones: [], now: NOW })).toEqual(
      [],
    );
  });

  it("never names an on-demand source, nor one that is not connected", () => {
    const connections = [
      oura({ key: "strava" }),
      oura({ key: "polar", health: null }),
    ];
    expect(resolveQuietSources({ connections, iphones: [], now: NOW })).toEqual(
      [],
    );
  });

  it("names Apple Health when an iPhone stalled and none still delivers", () => {
    const iphones = [
      { healthIngestAt: ago(3 * DAY), healthQuietSince: ago(3 * DAY) },
      { healthIngestAt: ago(2 * DAY), healthQuietSince: ago(2 * DAY) },
    ];
    expect(resolveQuietSources({ connections: [], iphones, now: NOW })).toEqual(
      [{ source: "apple-health", since: ago(2 * DAY) }],
    );
  });

  it("keeps Apple Health off while another iPhone delivers", () => {
    const iphones = [
      { healthIngestAt: ago(3 * DAY), healthQuietSince: ago(3 * DAY) },
      { healthIngestAt: ago(2 * HOUR), healthQuietSince: null },
    ];
    expect(resolveQuietSources({ connections: [], iphones, now: NOW })).toEqual(
      [],
    );
    expect(iphoneDelivers(ago(2 * HOUR), NOW)).toBe(true);
    expect(iphoneDelivers(ago(DAY + HOUR), NOW)).toBe(false);
  });

  it("names a source once, from its latest stamp", () => {
    const connections = [
      oura({
        key: "apple-health",
        silentSince: ago(5 * DAY),
        lastDataAt: ago(5 * DAY),
      }),
    ];
    const iphones = [
      { healthIngestAt: ago(3 * DAY), healthQuietSince: ago(3 * DAY) },
    ];
    expect(resolveQuietSources({ connections, iphones, now: NOW })).toEqual([
      { source: "apple-health", since: ago(3 * DAY) },
    ]);
  });
});

describe("quietSinceDate", () => {
  it("is the short local date the push prints, in the zone of the person", () => {
    expect(
      quietSinceDate(new Date("2026-11-18T23:30:00Z"), "Europe/Berlin", "en"),
    ).toBe("Nov 19");
  });
});
