import { describe, it, expect } from "vitest";
import type { MeasurementSource, SleepStage } from "@/generated/prisma/client";
import {
  reconstructSleepNights,
  reconstructSleepSessions,
  pickMainNightAndNaps,
  isDaytimeNap,
  separateNightsAndNaps,
  summarizeSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";

/** Build a stage row with a fixed wall-clock instant. */
function row(
  iso: string,
  stage: SleepStage | null,
  minutes: number,
  source?: MeasurementSource,
): SleepStageRow {
  return {
    measuredAt: new Date(iso),
    sleepStage: stage,
    value: minutes,
    ...(source ? { source } : {}),
  };
}

/** Build a stage row tagged with an ingest source. */
function srcRow(
  iso: string,
  stage: SleepStage | null,
  minutes: number,
  source: MeasurementSource,
): SleepStageRow {
  return {
    measuredAt: new Date(iso),
    sleepStage: stage,
    value: minutes,
    source,
  };
}

describe("reconstructSleepNights", () => {
  it("sums asleep stages into one night, excluding IN_BED + AWAKE", () => {
    // One night written as five per-stage rows (WHOOP / Apple shape), all
    // on the same UTC calendar day so the night-key collapses them.
    const rows: SleepStageRow[] = [
      row("2026-06-04T00:00:00.000Z", "IN_BED", 480),
      row("2026-06-04T00:30:00.000Z", "CORE", 240),
      row("2026-06-04T02:00:00.000Z", "DEEP", 90),
      row("2026-06-04T04:00:00.000Z", "REM", 80),
      row("2026-06-04T05:00:00.000Z", "AWAKE", 20),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    const main = nights[0];
    expect(main.night).toBe("2026-06-04");
    // Time asleep = CORE + DEEP + REM = 240 + 90 + 80 = 410. AWAKE excluded.
    expect(main.asleepMinutes).toBe(410);
    // AWAKE recorded but not counted as asleep.
    expect(main.awakeMinutes).toBe(20);
    // IN_BED row present → in-bed total surfaced.
    expect(main.inBedMinutes).toBe(480);
    expect(main.stages.CORE).toBe(240);
    expect(main.stages.DEEP).toBe(90);
    expect(main.stages.REM).toBe(80);
  });

  it("groups all stages of one night by the user's tz calendar day", () => {
    // In a non-UTC zone (Auckland = UTC+12 in June) a night whose stages
    // straddle UTC midnight still collapses to one local day. These
    // instants are all 2026-06-04 LOCAL (12:00–17:00 UTC = 00:00–05:00
    // Jun 4 Auckland) but straddle UTC midnight if keyed naively.
    const rows: SleepStageRow[] = [
      row("2026-06-03T12:00:00.000Z", "IN_BED", 480), // 00:00 Jun 4 NZST
      row("2026-06-03T13:00:00.000Z", "CORE", 240), // 01:00 Jun 4
      row("2026-06-03T15:00:00.000Z", "DEEP", 90), // 03:00 Jun 4
      row("2026-06-03T17:00:00.000Z", "REM", 80), // 05:00 Jun 4
    ];
    const nights = reconstructSleepNights(rows, "Pacific/Auckland");
    expect(nights).toHaveLength(1);
    expect(nights[0].night).toBe("2026-06-04");
    expect(nights[0].asleepMinutes).toBe(410);
    expect(nights[0].inBedMinutes).toBe(480);
  });

  it("treats a bare SLEEP_DURATION row (no stage) as the night total", () => {
    const rows: SleepStageRow[] = [row("2026-06-04T06:00:00.000Z", null, 423)];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    expect(nights[0].asleepMinutes).toBe(423);
    expect(nights[0].inBedMinutes).toBeNull();
  });

  it("keeps a night that straddles LOCAL midnight as ONE night (HIGH)", () => {
    // Berlin = UTC+2 in June. Asleep 22:30 → 06:15 LOCAL across CONTIGUOUS
    // stage segments (each ends where the next begins). The stage END instants
    // land on BOTH sides of local midnight, so a per-stage day key would split
    // the night in two and the headline would lose the pre-midnight sleep.
    // Session clustering must collapse them into one night keyed by the LOCAL
    // WAKE DAY (Jun 4, the morning the user wakes).
    const rows: SleepStageRow[] = [
      // IN_BED spans the whole night (22:30 → 06:15 local = 465 min).
      row("2026-06-04T04:15:00.000Z", "IN_BED", 465),
      row("2026-06-03T21:30:00.000Z", "CORE", 60), //  22:30 → 23:30 Jun 3
      row("2026-06-03T23:00:00.000Z", "DEEP", 90), //  23:30 → 01:00 (→ Jun 4)
      row("2026-06-04T01:00:00.000Z", "REM", 120), //  01:00 → 03:00 Jun 4
      row("2026-06-04T04:15:00.000Z", "CORE", 195), // 03:00 → 06:15 Jun 4
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    // Keyed by the wake day, not the fall-asleep day.
    expect(nights[0].night).toBe("2026-06-04");
    // Whole night summed: CORE 60 + DEEP 90 + REM 120 + CORE 195 = 465.
    expect(nights[0].asleepMinutes).toBe(465);
    expect(nights[0].inBedMinutes).toBe(465);
  });

  it("keeps a night that straddles a DST spring-forward as one night", () => {
    // Europe/Berlin springs forward 2026-03-29 02:00 → 03:00 local (UTC+1 →
    // UTC+2). A night asleep ~23:00 Mar 28 → ~07:00 Mar 29 local crosses the
    // skipped hour. The absolute-time gap clustering is DST-immune, and the
    // wake-day key resolves on the real instant, so it stays one night keyed
    // to the wake day (Mar 29).
    // Contiguous segments chained in UTC across the spring-forward seam.
    const rows: SleepStageRow[] = [
      row("2026-03-28T22:40:00.000Z", "CORE", 100), // 23:00 → 23:40 Mar 28 (UTC+1)
      row("2026-03-29T00:30:00.000Z", "DEEP", 110), // 23:40 → 01:30 Mar 29 (UTC+1)
      // 01:55 UTC = 03:55 Mar 29 local AFTER the spring-forward (UTC+2).
      row("2026-03-29T01:55:00.000Z", "REM", 85), //   01:30 → 03:55 Mar 29 (DST seam)
      row("2026-03-29T05:00:00.000Z", "CORE", 185), // 03:55 → 07:00 Mar 29 (UTC+2)
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    expect(nights[0].night).toBe("2026-03-29");
    // 100 + 110 + 85 + 185 = 480 asleep minutes, summed across the DST seam.
    expect(nights[0].asleepMinutes).toBe(480);
  });

  it("keeps a daytime nap separable from the following overnight night", () => {
    // A 15:00 nap and a 19:40→06:00 overnight block are > 3 h apart, so they
    // are two distinct sessions — the nap is NOT lumped into the night.
    const rows: SleepStageRow[] = [
      row("2026-06-03T13:00:00.000Z", "CORE", 45), //  14:15 → 15:00 Jun 3 nap
      // Overnight, contiguous: ~19:40 Jun 3 → 06:00 Jun 4 local.
      row("2026-06-03T21:00:00.000Z", "CORE", 200), // 19:40 → 23:00 Jun 3
      row("2026-06-03T23:00:00.000Z", "DEEP", 120), // 23:00 → 01:00 Jun 4
      row("2026-06-04T01:00:00.000Z", "REM", 120), //  01:00 → 03:00 Jun 4
      row("2026-06-04T04:00:00.000Z", "CORE", 180), // 03:00 → 06:00 Jun 4
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(2);
    // Nap keyed to its own wake day (Jun 3); overnight to Jun 4.
    expect(nights[0].night).toBe("2026-06-03");
    expect(nights[0].asleepMinutes).toBe(45);
    expect(nights[1].night).toBe("2026-06-04");
    expect(nights[1].asleepMinutes).toBe(620);
  });

  it("collapses a dual-source night to one canonical source (MEDIUM-1)", () => {
    // WHOOP + Apple Health both report the SAME night. The default `sleep`
    // ladder is WHOOP > APPLE_HEALTH > WITHINGS, so only WHOOP's stages are
    // summed — no double-count, no blend.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      // Apple Health's parallel rows for the same night — must be dropped.
      srcRow("2026-06-04T01:05:00.000Z", "CORE", 230, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:05:00.000Z", "DEEP", 85, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:35:00.000Z", "REM", 80, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    // WHOOP only: 240 + 90 + 90 = 420, NOT the ~825 blend of both sources.
    expect(nights[0].asleepMinutes).toBe(420);
    expect(nights[0].stages.CORE).toBe(240);
  });

  it("does NOT double-count a bare ASLEEP aggregate against the granular stages (HIGH, v1.11.5)", () => {
    // Apple Health writes BOTH an unspecified `ASLEEP` AGGREGATE row AND the
    // granular CORE/DEEP/REM breakdown for the SAME night. The granular rows
    // partition the same period the aggregate covers, so summing them would
    // ~double the night (here: 480 granular + 480 bare = 960 ≈ 16 h, the
    // real-data symptom). The asleep total must be the GRANULAR sum (~8 h),
    // never the granular + bare blend.
    const rows: SleepStageRow[] = [
      // Granular breakdown — the canonical partition (8 h total).
      row("2026-06-04T01:00:00.000Z", "CORE", 240), //  23:00 → 03:00
      row("2026-06-04T03:00:00.000Z", "DEEP", 120), //  03:00 → 05:00
      row("2026-06-04T05:00:00.000Z", "REM", 120), //   05:00 → 07:00
      // Unspecified ASLEEP aggregate covering the SAME 8 h — must be dropped.
      row("2026-06-04T05:00:00.000Z", "ASLEEP", 480),
      // IN_BED + AWAKE never count toward asleep.
      row("2026-06-04T05:00:00.000Z", "IN_BED", 510),
      row("2026-06-04T04:30:00.000Z", "AWAKE", 30),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    // Granular only: 240 + 120 + 120 = 480 (8 h), NOT 960 (16 h).
    expect(nights[0].asleepMinutes).toBe(480);
    expect(nights[0].inBedMinutes).toBe(510);
    expect(nights[0].awakeMinutes).toBe(30);
    // HIGH (H1): the per-stage `stages` map must NOT carry the bare ASLEEP
    // aggregate alongside the granular partition — it would render a
    // double-height green ASLEEP segment on top of CORE+DEEP+REM. Only the
    // granular stages + IN_BED + AWAKE survive.
    expect(nights[0].stages.ASLEEP).toBeUndefined();
    expect(nights[0].stages.CORE).toBe(240);
    expect(nights[0].stages.DEEP).toBe(120);
    expect(nights[0].stages.REM).toBe(120);
    expect(nights[0].stages.IN_BED).toBe(510);
    expect(nights[0].stages.AWAKE).toBe(30);
  });

  it("includes a bare-only nap in the night total when the overnight is granular (MEDIUM-1, v1.11.5)", () => {
    // Same wake day: a granular WHOOP overnight (8 h) plus a bare-ASLEEP-only
    // Apple nap (45 min) more than 3 h later. Reconstructing over the MERGED
    // pool would set sawGranular from the overnight and wrongly drop the
    // nap's bare ASLEEP. The per-session asleep total must keep the nap.
    const rows: SleepStageRow[] = [
      // Overnight (WHOOP, granular): 23:00 → 07:00 = 8 h asleep.
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 120, "WHOOP"),
      srcRow("2026-06-04T07:00:00.000Z", "REM", 120, "WHOOP"),
      // Afternoon nap (Apple, bare ASLEEP only): 14:00 → 14:45 = 45 min,
      // well beyond the 3 h session gap from the overnight.
      srcRow("2026-06-04T14:45:00.000Z", "ASLEEP", 45, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    // 480 (granular overnight) + 45 (bare nap) = 525, NOT 480 (nap dropped).
    expect(nights[0].asleepMinutes).toBe(525);
    // The night's stages carry the granular overnight AND the nap's bare
    // ASLEEP — the nap was a separate session with no granular partition, so
    // its bare aggregate is its only asleep signal and survives.
    expect(nights[0].stages.CORE).toBe(240);
    expect(nights[0].stages.DEEP).toBe(120);
    expect(nights[0].stages.REM).toBe(120);
    expect(nights[0].stages.ASLEEP).toBe(45);
  });

  it("falls back to the bare ASLEEP row when no granular stage exists", () => {
    // Legacy iOS 15- writes only the unspecified aggregate — there is no
    // granular partition, so the bare ASLEEP row IS the night's total.
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 465),
      row("2026-06-04T06:00:00.000Z", "IN_BED", 500),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    expect(nights[0].asleepMinutes).toBe(465);
    expect(nights[0].inBedMinutes).toBe(500);
  });

  it("does not double-count bare+granular WITHIN one source on a dual-source night", () => {
    // Both WHOOP and Apple Health report the same night, and EACH writes a
    // bare ASLEEP aggregate alongside its granular breakdown. The night must
    // collapse to ONE source (WHOOP by default ladder) AND count only that
    // source's granular stages — no cross-source sum, no bare double-count.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "ASLEEP", 420, "WHOOP"), // bare WHOOP aggregate
      srcRow("2026-06-04T01:05:00.000Z", "CORE", 230, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:05:00.000Z", "DEEP", 85, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:35:00.000Z", "REM", 80, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:35:00.000Z", "ASLEEP", 395, "APPLE_HEALTH"), // bare Apple aggregate
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    // WHOOP granular only: 240 + 90 + 90 = 420, not 840 (bare+granular) and
    // not the ~1660 four-way blend of both sources' bare + granular rows.
    expect(nights[0].asleepMinutes).toBe(420);
  });

  it("honours a per-user ladder that prefers Apple Health over WHOOP", () => {
    const priorityJson = { sleep: ["APPLE_HEALTH", "WHOOP"] };
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WHOOP"),
      srcRow("2026-06-04T01:05:00.000Z", "CORE", 230, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:05:00.000Z", "DEEP", 80, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "UTC", priorityJson);
    expect(nights).toHaveLength(1);
    // Apple Health wins under the override: 230 + 80 = 310.
    expect(nights[0].asleepMinutes).toBe(310);
  });

  it("prefers the stage-granular source over a coarse one regardless of ladder", () => {
    // Mixed night: WHOOP writes the full hypnogram (REM/CORE/DEEP/AWAKE),
    // Apple Health writes only coarse AWAKE/ASLEEP blocks + IN_BED for the
    // SAME night. Even with a ladder that ranks Apple Health first, the
    // granular WHOOP partition must carry the night — otherwise the chart
    // collapses to awake/asleep and the stages disappear.
    const priorityJson = { sleep: ["APPLE_HEALTH", "WHOOP"] };
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      srcRow("2026-06-04T04:40:00.000Z", "AWAKE", 10, "WHOOP"),
      // Apple Health's coarse parallel export of the same night.
      srcRow("2026-06-04T01:30:00.000Z", "ASLEEP", 110, "APPLE_HEALTH"),
      srcRow("2026-06-04T01:40:00.000Z", "AWAKE", 10, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:30:00.000Z", "ASLEEP", 100, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "ASLEEP", 60, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:40:00.000Z", "IN_BED", 430, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "UTC", priorityJson);
    expect(nights).toHaveLength(1);
    // WHOOP's granular partition: 240 + 90 + 90 = 420.
    expect(nights[0].asleepMinutes).toBe(420);
    expect(nights[0].stages.REM).toBe(90);
    expect(nights[0].stages.DEEP).toBe(90);
    expect(nights[0].stages.CORE).toBe(240);
    // The coarse source's bare ASLEEP blocks must not blend in.
    expect(nights[0].stages.ASLEEP).toBeUndefined();
  });

  it("keeps the coarse source as fallback when no granular source exists", () => {
    const priorityJson = { sleep: ["APPLE_HEALTH", "WHOOP"] };
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:30:00.000Z", "ASLEEP", 110, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:30:00.000Z", "ASLEEP", 100, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "UTC", priorityJson);
    expect(nights).toHaveLength(1);
    expect(nights[0].asleepMinutes).toBe(210);
  });
});

describe("reconstructSleepSessions", () => {
  it("resolves each stage row to start = end − duration", () => {
    const rows: SleepStageRow[] = [
      // 240-min CORE ending 03:00 UTC → starts 23:00 the previous instant.
      row("2026-06-04T03:00:00.000Z", "CORE", 240),
      row("2026-06-04T04:30:00.000Z", "REM", 90), // 03:00 → 04:30
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.start.toISOString()).toBe("2026-06-03T23:00:00.000Z");
    expect(s.end.toISOString()).toBe("2026-06-04T04:30:00.000Z");
    // Segments carry their own start/end span.
    const core = s.segments.find((seg) => seg.stage === "CORE");
    expect(core?.start.toISOString()).toBe("2026-06-03T23:00:00.000Z");
    expect(core?.end.toISOString()).toBe("2026-06-04T03:00:00.000Z");
    expect(s.asleepMinutes).toBe(330);
  });

  it("splits a daytime nap into its own session, separate from the night", () => {
    const rows: SleepStageRow[] = [
      row("2026-06-03T13:00:00.000Z", "CORE", 45), //  14:15 → 15:00 nap
      // Overnight contiguous block.
      row("2026-06-03T21:00:00.000Z", "CORE", 200),
      row("2026-06-03T23:00:00.000Z", "DEEP", 120),
      row("2026-06-04T01:00:00.000Z", "REM", 120),
      row("2026-06-04T04:00:00.000Z", "CORE", 180),
    ];
    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    expect(sessions).toHaveLength(2);
    // Sorted ascending by start: nap first, overnight second.
    expect(sessions[0].asleepMinutes).toBe(45);
    expect(sessions[1].asleepMinutes).toBe(620);
  });

  it("keeps only the canonical source's segments on a dual-source night", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      srcRow("2026-06-04T01:05:00.000Z", "CORE", 230, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:05:00.000Z", "DEEP", 85, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("WHOOP");
    // Only WHOOP's 3 segments survive; Apple Health's are dropped.
    expect(sessions[0].segments).toHaveLength(3);
    expect(sessions[0].asleepMinutes).toBe(420);
  });

  it("flags a WHOOP-won night as reconstructed (synthetic stage order) with clock-time-distinct segments", () => {
    // The ingest mapper reconstructs an ordered, contiguous WHOOP timeline.
    // The reconstructed segments carry distinct measuredAt instants, so the
    // hypnogram lays them at distinct clock times (no shared right edge).
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"), // 21:00→01:00
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 120, "WHOOP"), // 01:00→03:00
      srcRow("2026-06-04T05:00:00.000Z", "REM", 120, "WHOOP"), //  03:00→05:00
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.source).toBe("WHOOP");
    expect(s.reconstructed).toBe(true);
    // No two segments end on the same instant — not stacked on the right edge.
    const ends = s.segments.map((seg) => seg.end.getTime());
    expect(new Set(ends).size).toBe(ends.length);
  });

  it("flags a Polar-won night as reconstructed (synthetic stage order)", () => {
    // Polar exposes only per-stage duration totals, so its mapper reconstructs
    // a contiguous CORE→DEEP→REM order exactly like WHOOP. The reader must label
    // such a night reconstructed so the UI never presents the synthetic order as
    // measured timing.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "POLAR"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 120, "POLAR"),
      srcRow("2026-06-04T05:00:00.000Z", "REM", 120, "POLAR"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("POLAR");
    expect(sessions[0].reconstructed).toBe(true);
  });

  it("does NOT flag an Apple-Health night as reconstructed (measured timeline)", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("APPLE_HEALTH");
    expect(sessions[0].reconstructed).toBe(false);
  });

  it("does NOT flag a Withings night as reconstructed (real per-segment series)", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WITHINGS"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WITHINGS"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("WITHINGS");
    expect(sessions[0].reconstructed).toBe(false);
  });

  it("drops the bare ASLEEP aggregate from segments + stages when granular exists (HIGH H1, v1.11.5)", () => {
    // Apple-Health shape: granular CORE/DEEP/REM PLUS the unspecified ASLEEP
    // aggregate covering the same period, plus IN_BED. The hypnogram must not
    // draw a double-height ASLEEP lane on top of the granular stages, so the
    // bare ASLEEP segment is dropped and `stages.ASLEEP` is absent.
    const rows: SleepStageRow[] = [
      row("2026-06-04T01:00:00.000Z", "CORE", 240),
      row("2026-06-04T03:00:00.000Z", "DEEP", 120),
      row("2026-06-04T05:00:00.000Z", "REM", 120),
      row("2026-06-04T05:00:00.000Z", "ASLEEP", 480), // redundant aggregate
      row("2026-06-04T05:00:00.000Z", "IN_BED", 510),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // No ASLEEP segment survives; CORE + DEEP + REM + IN_BED do (4 segments).
    expect(s.segments.some((seg) => seg.stage === "ASLEEP")).toBe(false);
    expect(s.segments).toHaveLength(4);
    expect(s.stages.ASLEEP).toBeUndefined();
    expect(s.asleepMinutes).toBe(480); // granular sum, not 960
    expect(s.inBedMinutes).toBe(510);
  });

  it("prefers a per-segment timeline writer over a summary-shaped writer (v1.16.11)", () => {
    // WHOOP's real wire shape: the v2 API exposes only stage_summary, so
    // every stage row of a night lands with ONE shared measuredAt — the
    // sleep END instant. Reconstructing those as segments yields five
    // spans all touching the right edge of the night. When Apple Health
    // carries genuinely timed per-segment rows for the same night, the
    // timed writer must win even though WHOOP ties (or wins) on distinct
    // stage count and outranks Apple on the default ladder.
    const end = "2026-06-04T05:00:00.000Z";
    const rows: SleepStageRow[] = [
      // WHOOP: full-house stage summary, all stamped on the sleep end.
      srcRow(end, "IN_BED", 510, "WHOOP"),
      srcRow(end, "AWAKE", 30, "WHOOP"),
      srcRow(end, "CORE", 240, "WHOOP"),
      srcRow(end, "DEEP", 120, "WHOOP"),
      srcRow(end, "REM", 120, "WHOOP"),
      // Apple Health: a partial but genuinely timed timeline (2 stages).
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 120, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("APPLE_HEALTH");
    // The surviving segments carry a real timeline: more than one
    // distinct end instant.
    const ends = new Set(sessions[0].segments.map((seg) => seg.end.getTime()));
    expect(ends.size).toBeGreaterThan(1);
  });

  it("keeps a summary-shaped writer when nobody else covers the night (v1.16.11)", () => {
    // WHOOP-only night — the stage summary is all there is, so it must
    // still resolve (the timeline gate is conditional, not absolute).
    const end = "2026-06-04T05:00:00.000Z";
    const rows: SleepStageRow[] = [
      srcRow(end, "CORE", 240, "WHOOP"),
      srcRow(end, "DEEP", 120, "WHOOP"),
      srcRow(end, "REM", 120, "WHOOP"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("WHOOP");
    expect(sessions[0].asleepMinutes).toBe(480);
  });

  it("keeps the bare ASLEEP segment when NO granular stage exists", () => {
    // Legacy ASLEEP-only night — the bare aggregate IS the timeline, so it
    // must survive as a segment (otherwise the hypnogram would have nothing).
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 450),
      row("2026-06-04T06:00:00.000Z", "IN_BED", 480),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].segments.some((seg) => seg.stage === "ASLEEP")).toBe(
      true,
    );
    expect(sessions[0].stages.ASLEEP).toBe(450);
    expect(sessions[0].asleepMinutes).toBe(450);
  });

  it("counts only MID-sleep AWAKE bouts as awakenings", () => {
    const rows: SleepStageRow[] = [
      // Leading AWAKE before sleep onset — NOT an awakening.
      row("2026-06-04T00:10:00.000Z", "AWAKE", 10),
      row("2026-06-04T02:00:00.000Z", "CORE", 110),
      // Mid-sleep AWAKE bout — counts.
      row("2026-06-04T02:15:00.000Z", "AWAKE", 15),
      row("2026-06-04T04:00:00.000Z", "DEEP", 105),
      // Another mid-sleep AWAKE bout — counts.
      row("2026-06-04T04:10:00.000Z", "AWAKE", 10),
      row("2026-06-04T06:00:00.000Z", "REM", 110),
      // Trailing AWAKE after final wake — NOT an awakening.
      row("2026-06-04T06:05:00.000Z", "AWAKE", 5),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].awakenings).toBe(2);
  });

  it("returns no sessions for empty input", () => {
    expect(reconstructSleepSessions([], "UTC")).toEqual([]);
  });
});

describe("pickMainNightAndNaps", () => {
  it("picks the longest-asleep session as the main night, rest as naps", () => {
    // Same wake day (Berlin): a short nap + the overnight block.
    const rows: SleepStageRow[] = [
      row("2026-06-04T11:00:00.000Z", "CORE", 40), // 12:00 → 12:40 nap (Jun 4)
      // Overnight ~22:00 Jun 3 → 06:00 Jun 4.
      row("2026-06-03T21:00:00.000Z", "CORE", 180),
      row("2026-06-04T00:00:00.000Z", "DEEP", 120),
      row("2026-06-04T04:00:00.000Z", "REM", 180),
    ];
    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    const { main, naps } = pickMainNightAndNaps(sessions);
    expect(main?.asleepMinutes).toBe(480);
    expect(naps).toHaveLength(1);
    expect(naps[0].asleepMinutes).toBe(40);
    // Nap shares the main night's wake day.
    expect(naps[0].night).toBe(main?.night);
  });

  it("returns no main when every session is IN_BED/AWAKE only", () => {
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "IN_BED", 60),
      row("2026-06-04T06:00:00.000Z", "AWAKE", 60),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    const { main, naps } = pickMainNightAndNaps(sessions);
    expect(main).toBeNull();
    expect(naps).toEqual([]);
  });

  it("does not surface a different wake day's session as a nap", () => {
    // Two overnight blocks on consecutive wake days — neither is the
    // other's nap even though both land in the same input array.
    const rows: SleepStageRow[] = [
      // Wake day Jun 3.
      row("2026-06-03T01:00:00.000Z", "CORE", 240),
      row("2026-06-03T05:00:00.000Z", "DEEP", 120),
      // Wake day Jun 4.
      row("2026-06-04T01:00:00.000Z", "CORE", 300),
      row("2026-06-04T05:00:00.000Z", "DEEP", 120),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    const { main, naps } = pickMainNightAndNaps(sessions);
    // Jun 4 is the longer night.
    expect(main?.night).toBe("2026-06-04");
    expect(naps).toEqual([]);
  });
});

describe("the one nap rule", () => {
  it("tells a nap from a night by length and time of day together", () => {
    // Short and in the afternoon: a nap.
    expect(isDaytimeNap(60, 14 * 60)).toBe(true);
    // Short but at night: the night.
    expect(isDaytimeNap(150, 2 * 60)).toBe(false);
    expect(isDaytimeNap(150, 22 * 60)).toBe(false);
    // A late sleeper's short night, centred at 09:00.
    expect(isDaytimeNap(150, 9 * 60)).toBe(false);
    // Long in the daytime (after a night shift): a main sleep.
    expect(isDaytimeNap(420, 13 * 60)).toBe(false);
  });

  it("gives a day of naps alone no main night", () => {
    // 14:00 to 15:00 Berlin, nothing overnight (the watch was charging).
    const rows: SleepStageRow[] = [row("2026-06-04T13:00:00.000Z", "CORE", 60)];
    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    const { main, naps } = pickMainNightAndNaps(sessions);
    expect(main).toBeNull();
    expect(naps).toHaveLength(1);
    expect(naps[0].daytimeNap).toBe(true);
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights[0].asleepMinutes).toBe(60);
    expect(nights[0].mainSession).toBeNull();
    expect(separateNightsAndNaps(sessions)).toEqual([
      { night: "2026-06-04", main: null, naps },
    ]);
  });

  it("keeps a short night as the main sleep over a longer afternoon nap", () => {
    const rows: SleepStageRow[] = [
      // 02:00 to 03:30 Berlin: a broken night, 90 minutes.
      row("2026-06-04T01:30:00.000Z", "CORE", 90),
      // 13:00 to 15:00 Berlin: a two-hour nap.
      row("2026-06-04T13:00:00.000Z", "CORE", 120),
    ];
    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    const { main, naps } = pickMainNightAndNaps(sessions);
    expect(main?.asleepMinutes).toBe(90);
    expect(naps.map((n) => n.asleepMinutes)).toEqual([120]);
    // The merged night places the same session on the clock.
    const [night] = reconstructSleepNights(rows, "Europe/Berlin");
    expect(night.mainSession?.asleepMinutes).toBe(90);
    expect(night.mainSession?.end.getTime()).toBe(main?.end.getTime());
  });

  it("files a session under the day its last row ends on, over every writer", () => {
    // The watch stops at 23:50 UTC; the phone's in-bed span runs to 00:10.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-03T23:50:00.000Z", "CORE", 170, "WHOOP"),
      srcRow("2026-06-04T00:10:00.000Z", "IN_BED", 200, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    const nights = reconstructSleepNights(rows, "UTC");
    expect(sessions.map((s) => s.night)).toEqual(["2026-06-04"]);
    expect(nights.map((n) => n.night)).toEqual(["2026-06-04"]);
  });
});

describe("a zero-minute granular row", () => {
  it("does not strip the bare aggregate that carries the night", () => {
    // A writer's bare 6-hour night beside a REM row of no length: the REM
    // row partitions nothing, so the night is the aggregate's six hours.
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 360),
      row("2026-06-04T06:00:00.000Z", "REM", 0),
    ];
    const [session] = reconstructSleepSessions(rows, "UTC");
    expect(session.asleepMinutes).toBe(360);
    expect(session.stages.ASLEEP).toBe(360);
    expect(reconstructSleepNights(rows, "UTC")[0].asleepMinutes).toBe(360);
  });
});

describe("summarizeSleepNights", () => {
  it("summarises per-night totals, not per-stage rows", () => {
    const rows: SleepStageRow[] = [
      // Night A — 2026-06-03: 200 + 100 = 300 asleep min.
      row("2026-06-03T01:00:00.000Z", "CORE", 200),
      row("2026-06-03T03:00:00.000Z", "DEEP", 100),
      // Night B — 2026-06-04: 240 + 90 + 90 = 420 asleep min.
      row("2026-06-04T01:00:00.000Z", "CORE", 240),
      row("2026-06-04T03:00:00.000Z", "DEEP", 90),
      row("2026-06-04T04:30:00.000Z", "REM", 90),
    ];
    const { summary, latestNight } = summarizeSleepNights(rows, "UTC");
    // count = nights, NOT stage rows (5).
    expect(summary.count).toBe(2);
    // latest = most-recent night total (minutes), not a single stage.
    expect(summary.latest).toBe(420);
    expect(summary.min).toBe(300);
    expect(summary.max).toBe(420);
    expect(summary.mean).toBe(360);
    expect(latestNight?.night).toBe("2026-06-04");
    expect(latestNight?.asleepMinutes).toBe(420);
  });

  it("averages ~8 h, not ~16 h, when every night carries bare+granular rows (HIGH, v1.11.5)", () => {
    // Several consecutive nights, each written the real-data way: a bare
    // ASLEEP aggregate PLUS the granular CORE/DEEP/REM partition for the same
    // period. The 30-day-style average must reflect the granular ~8 h totals,
    // not the ~16 h bare+granular blend that produced the live 16.4 h symptom.
    const nightsInput: Array<[string, number, number, number]> = [
      // [wake-day, core, deep, rem] — each sums to 480 min = 8 h.
      ["2026-06-01", 240, 120, 120],
      ["2026-06-02", 250, 110, 120],
      ["2026-06-03", 230, 130, 120],
      ["2026-06-04", 240, 120, 120],
    ];
    const rows: SleepStageRow[] = [];
    for (const [day, core, deep, rem] of nightsInput) {
      // Each night's stages land between 01:00 and 06:00 UTC on the wake day.
      rows.push(row(`${day}T02:00:00.000Z`, "CORE", core));
      rows.push(row(`${day}T04:00:00.000Z`, "DEEP", deep));
      rows.push(row(`${day}T06:00:00.000Z`, "REM", rem));
      // The overlapping bare ASLEEP aggregate (= core+deep+rem) — must drop.
      rows.push(row(`${day}T06:00:00.000Z`, "ASLEEP", core + deep + rem));
    }
    const { summary } = summarizeSleepNights(rows, "UTC");
    expect(summary.count).toBe(4);
    // Mean of 480 / 480 / 480 / 480 = 480 min = 8 h, NOT 960 min = 16 h.
    expect(summary.mean).toBe(480);
    expect((summary.mean ?? 0) / 60).toBe(8);
  });

  it("drops nights with zero asleep minutes (IN_BED / AWAKE only)", () => {
    const rows: SleepStageRow[] = [
      row("2026-06-03T23:00:00.000Z", "IN_BED", 60),
      row("2026-06-03T23:30:00.000Z", "AWAKE", 60),
    ];
    const { summary, latestNight } = summarizeSleepNights(rows, "UTC");
    expect(summary.count).toBe(0);
    expect(latestNight).toBeNull();
  });

  it("returns an empty summary for no rows", () => {
    const { summary, latestNight } = summarizeSleepNights([], "UTC");
    expect(summary.count).toBe(0);
    expect(summary.latest).toBeNull();
    expect(latestNight).toBeNull();
  });

  it("the latest night is the most-recent COMPLETE midnight-spanning night", () => {
    // The headline reads `latestNight.asleepMinutes`. With a midnight-spanning
    // last night, the old per-stage keying would have made the latest "night"
    // the post-midnight fragment only. After the fix the latest night carries
    // the full asleep total.
    const rows: SleepStageRow[] = [
      // Older complete night → Jun 3 (contiguous).
      row("2026-06-02T23:00:00.000Z", "CORE", 200), // 21:00 → 01:00 Jun 3
      row("2026-06-03T01:00:00.000Z", "DEEP", 120), // 01:00 → 03:00 Jun 3
      // Last night, asleep before local midnight → Jun 4 (contiguous).
      row("2026-06-03T21:00:00.000Z", "CORE", 150), // 20:30 → 23:00 Jun 3
      row("2026-06-03T23:30:00.000Z", "DEEP", 150), // 23:00 → 01:30 Jun 4
      row("2026-06-04T04:00:00.000Z", "REM", 270), //  23:30 → 06:00 Jun 4
    ];
    const { summary, latestNight } = summarizeSleepNights(
      rows,
      "Europe/Berlin",
    );
    expect(summary.count).toBe(2);
    expect(latestNight?.night).toBe("2026-06-04");
    // Full last night = 150 + 150 + 270 = 570 (not just a post-midnight slice).
    expect(latestNight?.asleepMinutes).toBe(570);
    expect(summary.latest).toBe(570);
  });
});

// A4 — the Insights sleep AVERAGE must come from the deduped per-night totals,
// never the raw per-stage sum that double-counts a bare ASLEEP aggregate against
// its granular twin (and folds IN_BED / AWAKE in on top). The ~20.3 h symptom is
// what a single night's stage rows summed without dedup produces.
describe("sleep average dedup (A4)", () => {
  it("one source emits BOTH bare ASLEEP + granular for the same span → dedup total, not the sum", () => {
    // Apple-Health-style double write for ONE overnight session: the bare
    // ASLEEP aggregate (480) PLUS the granular CORE/DEEP/REM partition (also
    // 480), plus IN_BED + AWAKE. Summed raw this is ~1490 min (~24.8 h); the
    // deduped night total is the granular 480 min (8 h).
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 480, "APPLE_HEALTH"), // bare aggregate
      row("2026-06-04T02:00:00.000Z", "CORE", 240, "APPLE_HEALTH"),
      row("2026-06-04T04:00:00.000Z", "DEEP", 120, "APPLE_HEALTH"),
      row("2026-06-04T06:00:00.000Z", "REM", 120, "APPLE_HEALTH"),
      row("2026-06-04T06:30:00.000Z", "IN_BED", 470, "APPLE_HEALTH"),
      row("2026-06-04T03:00:00.000Z", "AWAKE", 20, "APPLE_HEALTH"),
    ];
    const { summary } = summarizeSleepNights(rows, "UTC");
    // Granular partition wins: 240 + 120 + 120 = 480 min — NOT 480 + 480 + …
    expect(summary.latest).toBe(480);
    expect(summary.max).toBe(480);
    // One night, not 6 stage rows.
    expect(summary.count).toBe(1);
  });

  it("multi-source bare+granular collapses to the canonical source, no cross-source sum", () => {
    // WHOOP granular + Apple bare-only for the SAME night. The canonical source
    // (WHOOP, top of the sleep ladder) wins; the night total is WHOOP's dedup
    // total, never WHOOP + Apple summed.
    const rows: SleepStageRow[] = [
      // WHOOP granular — 240 + 120 + 120 = 480.
      row("2026-06-04T02:00:00.000Z", "CORE", 240, "WHOOP"),
      row("2026-06-04T04:00:00.000Z", "DEEP", 120, "WHOOP"),
      row("2026-06-04T06:00:00.000Z", "REM", 120, "WHOOP"),
      // Apple bare aggregate for the same span — must NOT add on top.
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 470, "APPLE_HEALTH"),
    ];
    const { summary } = summarizeSleepNights(rows, "UTC");
    expect(summary.count).toBe(1);
    expect(summary.latest).toBe(480); // WHOOP only, not 480 + 470.
  });
});

// A5 — `reconstructSleepSessions` must never throw on a session the dedup
// empties (the unguarded `segments[0]` access). A read returns a valid empty
// night, never a 500.
describe("reconstructSleepSessions total-safety (A5)", () => {
  it("never throws on an IN_BED/AWAKE-only session and yields no main night", () => {
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "IN_BED", 60),
      row("2026-06-04T06:00:00.000Z", "AWAKE", 60),
    ];
    expect(() => reconstructSleepSessions(rows, "UTC")).not.toThrow();
    const sessions = reconstructSleepSessions(rows, "UTC");
    // Every returned session has at least one renderable segment.
    expect(sessions.every((s) => s.segments.length > 0)).toBe(true);
    expect(pickMainNightAndNaps(sessions).main).toBeNull();
  });

  it("skips a session that empties after the granular-over-bare filter, never throws", () => {
    // A session whose canonical pool, after dropping the redundant bare ASLEEP
    // aggregate / stage-less twins under `sawGranular`, has zero renderable
    // segments. The DEEP granular row marks the session granular; the bare +
    // stage-less rows are then filtered out. The granular row survives here, so
    // assert the load-bearing contract: no throw, and every returned session is
    // non-empty.
    const rows: SleepStageRow[] = [
      row("2026-06-04T02:00:00.000Z", "DEEP", 1), // tiny granular marker
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 480), // redundant bare twin
      row("2026-06-04T06:00:00.000Z", null, 480), // stage-less twin
    ];
    expect(() => reconstructSleepSessions(rows, "UTC")).not.toThrow();
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions.every((s) => s.segments.length > 0)).toBe(true);
  });

  it("never throws on a stage-less-only session", () => {
    // Legacy / manual stage-less rows only — no granular partition, so they are
    // the fallback signal and survive the filter; still must not throw.
    const rows: SleepStageRow[] = [row("2026-06-04T06:00:00.000Z", null, 480)];
    expect(() => reconstructSleepSessions(rows, "UTC")).not.toThrow();
  });
});

/** Build a stage row tagged with a source AND a writer device-type. */
function writerRow(
  iso: string,
  stage: SleepStage | null,
  minutes: number,
  source: MeasurementSource,
  deviceType: string | null,
): SleepStageRow {
  return {
    measuredAt: new Date(iso),
    sleepStage: stage,
    value: minutes,
    source,
    deviceType,
  };
}

describe("per-night writer richness pick", () => {
  it("a coarse awake-heavy source never masks the source that knows the stages", () => {
    // The reported night: one source contributes a huge AWAKE block plus a
    // sliver of bare ASLEEP (a phone/in-bed detection mis-scoring the night),
    // the other carries the full hypnogram. The stage-bearing source must
    // win the night — the headline is NOT 400 awake minutes with no phases.
    const rows: SleepStageRow[] = [
      // Coarse export: 22:50 → 06:35 local, awake-dominant.
      srcRow("2026-06-04T01:00:00.000Z", "IN_BED", 250, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "AWAKE", 400, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:35:00.000Z", "ASLEEP", 30, "APPLE_HEALTH"),
      // Detailed stages for the SAME night.
      srcRow("2026-06-04T01:30:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 80, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "AWAKE", 35, "WHOOP"),
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    expect(nights[0].stages.CORE).toBe(240);
    expect(nights[0].stages.DEEP).toBe(80);
    expect(nights[0].stages.REM).toBe(90);
    // The winner's own awake minutes survive; the coarse 400 must not.
    expect(nights[0].awakeMinutes).toBe(35);
    expect(nights[0].asleepMinutes).toBe(410);
    // The losing writer's IN_BED envelope survives — "Zeit im Bett" is a
    // union across writers, never erased by the stage-richness pick.
    expect(nights[0].inBedMinutes).toBe(250);

    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("WHOOP");
    expect(sessions[0].stages.AWAKE).toBe(35);
    expect(sessions[0].inBedMinutes).toBe(250);
  });

  it("separates writer apps behind ONE source: phone in-bed must not blend into watch stages", () => {
    // Several HealthKit apps write under source = APPLE_HEALTH. The watch
    // carries the granular partition; the phone's bedtime detection writes a
    // parallel IN_BED + a long AWAKE block. Collapsing per source would blend
    // both writers and inflate the night's awake total — the device-type
    // refinement must keep only the stage-bearing writer.
    const rows: SleepStageRow[] = [
      writerRow(
        "2026-06-04T00:30:00.000Z",
        "CORE",
        120,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T02:30:00.000Z",
        "DEEP",
        60,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow("2026-06-04T04:00:00.000Z", "REM", 80, "APPLE_HEALTH", "watch"),
      writerRow(
        "2026-06-04T04:30:00.000Z",
        "AWAKE",
        15,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T04:30:00.000Z",
        "IN_BED",
        460,
        "APPLE_HEALTH",
        "phone",
      ),
      writerRow(
        "2026-06-04T00:35:00.000Z",
        "ASLEEP",
        200,
        "APPLE_HEALTH",
        "phone",
      ),
      writerRow(
        "2026-06-04T03:00:00.000Z",
        "AWAKE",
        385,
        "APPLE_HEALTH",
        "phone",
      ),
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    expect(nights[0].stages.CORE).toBe(120);
    expect(nights[0].stages.DEEP).toBe(60);
    expect(nights[0].stages.REM).toBe(80);
    // The watch writer's awake sliver, not the phone's 385-minute block.
    expect(nights[0].awakeMinutes).toBe(15);
    // The phone's bare ASLEEP must not blend into the asleep total either.
    expect(nights[0].asleepMinutes).toBe(260);
    // The night keeps the stages AND a sane in-bed figure: the watch wins
    // the stage views, but "Zeit im Bett" is the union envelope across
    // writers — the phone's 460-minute IN_BED window must not shrink to
    // null just because the watch carried no IN_BED row.
    expect(nights[0].inBedMinutes).toBe(460);

    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    expect(sessions).toHaveLength(1);
    // The session's hypnogram segments stay winner-only (no phone lanes)…
    expect(sessions[0].segments.some((seg) => seg.stage === "IN_BED")).toBe(
      false,
    );
    // …while the session-level in-bed figure keeps the phone's envelope.
    expect(sessions[0].inBedMinutes).toBe(460);
  });

  it("merges overlapping IN_BED spans from two writers without double-counting", () => {
    // Watch and phone both export an IN_BED window for the same night;
    // the spans overlap by four hours. The union envelope is 22:00 →
    // 06:00 (480 min), never the 360 + 360 = 720 sum.
    const rows: SleepStageRow[] = [
      writerRow(
        "2026-06-04T02:00:00.000Z",
        "CORE",
        200,
        "APPLE_HEALTH",
        "watch",
      ),
      // Watch IN_BED 22:00 → 04:00 UTC.
      writerRow(
        "2026-06-04T04:00:00.000Z",
        "IN_BED",
        360,
        "APPLE_HEALTH",
        "watch",
      ),
      // Phone IN_BED 00:00 → 06:00 UTC — overlaps the watch span.
      writerRow(
        "2026-06-04T06:00:00.000Z",
        "IN_BED",
        360,
        "APPLE_HEALTH",
        "phone",
      ),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    expect(nights[0].inBedMinutes).toBe(480);
  });

  it("rows without a device-type collapse per source exactly as before", () => {
    // Legacy rows (pre device-type column) and single-writer sources: one
    // bucket per source — granular + in-bed from the same source stay one
    // night with both facets.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T00:30:00.000Z", "CORE", 120, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "AWAKE", 15, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "IN_BED", 460, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    expect(nights[0].stages.CORE).toBe(120);
    expect(nights[0].inBedMinutes).toBe(460);
    expect(nights[0].awakeMinutes).toBe(15);
  });

  it("the RICHEST stage set wins: three granular stages beat one, regardless of ladder", () => {
    // WHOOP sits first on the default ladder but only knows CORE for this
    // night; the watch carries the full three-stage hypnogram. Per-night
    // richness must pick the watch.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T04:30:00.000Z", "CORE", 300, "WHOOP"),
      writerRow(
        "2026-06-04T00:30:00.000Z",
        "CORE",
        120,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T02:30:00.000Z",
        "DEEP",
        60,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow("2026-06-04T04:00:00.000Z", "REM", 80, "APPLE_HEALTH", "watch"),
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    expect(nights[0].stages.REM).toBe(80);
    expect(nights[0].stages.DEEP).toBe(60);
    expect(nights[0].stages.CORE).toBe(120);
    expect(nights[0].asleepMinutes).toBe(260);
  });

  it("equally rich writers fall back to the ladder (WHOOP beats Apple Health)", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 80, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      writerRow(
        "2026-06-04T00:30:00.000Z",
        "CORE",
        120,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T02:30:00.000Z",
        "DEEP",
        60,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow("2026-06-04T04:00:00.000Z", "REM", 80, "APPLE_HEALTH", "watch"),
    ];
    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("WHOOP");
    expect(sessions[0].asleepMinutes).toBe(410);
  });

  it("a coarse-only night heals on the next read once the stage rows land", () => {
    // The reconstruction is read-time: a night first assembled from coarse
    // rows (detailed sync lagging) must flip to the stage partition as soon
    // as the detailed rows exist — no manual repair, no cache to clear.
    const coarseOnly: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "IN_BED", 250, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "AWAKE", 400, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:35:00.000Z", "ASLEEP", 30, "APPLE_HEALTH"),
    ];
    const before = reconstructSleepNights(coarseOnly, "Europe/Berlin");
    expect(before[0].stages.REM).toBeUndefined();
    expect(before[0].awakeMinutes).toBe(400);

    const afterRows: SleepStageRow[] = [
      ...coarseOnly,
      srcRow("2026-06-04T01:30:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 80, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
    ];
    const after = reconstructSleepNights(afterRows, "Europe/Berlin");
    expect(after).toHaveLength(1);
    expect(after[0].stages.REM).toBe(90);
    expect(after[0].stages.DEEP).toBe(80);
    expect(after[0].stages.CORE).toBe(240);
    expect(after[0].awakeMinutes).toBeNull();
    expect(after[0].asleepMinutes).toBe(410);
  });
});

describe("source discrepancy annotation", () => {
  // Granular Apple night (300 + 90 + 65 = 455 asleep minutes) next to a
  // bare Withings aggregate claiming 615 for the same session. Apple wins
  // the night on granular richness; Withings' disagreement is observed
  // only, never blended into the served total.
  const discrepantRows: SleepStageRow[] = [
    srcRow("2026-06-04T00:30:00.000Z", "CORE", 300, "APPLE_HEALTH"),
    srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
    srcRow("2026-06-04T05:00:00.000Z", "REM", 65, "APPLE_HEALTH"),
    srcRow("2026-06-04T05:30:00.000Z", "ASLEEP", 615, "WITHINGS"),
  ];

  it("flags two writer buckets whose asleep totals clearly disagree", () => {
    const sessions = reconstructSleepSessions(discrepantRows, "UTC");
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.sourceDiscrepancy).toEqual({
      deltaMinutes: 160,
      sources: [
        { source: "WITHINGS", deviceType: null, asleepMinutes: 615 },
        { source: "APPLE_HEALTH", deviceType: null, asleepMinutes: 455 },
      ],
    });
  });

  it("never changes the served total — the winning writer's number stands", () => {
    // The flagged night serves the SAME asleep total as the identical night
    // without the disagreeing second writer: the annotation observes, the
    // writer collapse decides.
    const flagged = reconstructSleepSessions(discrepantRows, "UTC");
    const winnerOnly = reconstructSleepSessions(
      discrepantRows.filter((r) => r.source === "APPLE_HEALTH"),
      "UTC",
    );
    expect(flagged[0].source).toBe("APPLE_HEALTH");
    expect(flagged[0].asleepMinutes).toBe(455);
    expect(flagged[0].asleepMinutes).toBe(winnerOnly[0].asleepMinutes);
    expect(winnerOnly[0].sourceDiscrepancy).toBeNull();
  });

  it("stays null when the buckets agree within the absolute threshold", () => {
    // 480 vs 455 → delta 25 ≤ 45 min: ordinary sensor variance, no flag.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T00:30:00.000Z", "CORE", 300, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
      srcRow("2026-06-04T05:00:00.000Z", "REM", 65, "APPLE_HEALTH"),
      srcRow("2026-06-04T05:30:00.000Z", "ASLEEP", 480, "WITHINGS"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sourceDiscrepancy).toBeNull();
  });

  it("stays null when the delta clears the floor but not the relative gate", () => {
    // 555 vs 500 → delta 55 > 45 min but ≤ 20% of 555 (111): a one-hour
    // spread on a long night is not a clear disagreement.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T00:30:00.000Z", "CORE", 345, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
      srcRow("2026-06-04T05:00:00.000Z", "REM", 65, "APPLE_HEALTH"),
      srcRow("2026-06-04T05:30:00.000Z", "ASLEEP", 555, "WITHINGS"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].asleepMinutes).toBe(500);
    expect(sessions[0].sourceDiscrepancy).toBeNull();
  });

  it("stays null for a single-writer session", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T00:30:00.000Z", "CORE", 300, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sourceDiscrepancy).toBeNull();
  });

  it("an IN_BED/AWAKE-only writer makes no asleep claim and never flags", () => {
    // The classic watch + phone pairing: the phone writes only the in-bed
    // envelope. It carries no asleep total, so there is nothing to disagree
    // about — the marker must not fire on every dual-writer Apple night.
    const rows: SleepStageRow[] = [
      writerRow(
        "2026-06-04T00:30:00.000Z",
        "CORE",
        300,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T03:00:00.000Z",
        "DEEP",
        90,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T05:30:00.000Z",
        "IN_BED",
        480,
        "APPLE_HEALTH",
        "phone",
      ),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sourceDiscrepancy).toBeNull();
  });

  it("distinguishes two writers behind one source by device type", () => {
    // Watch granular vs phone coarse ASLEEP behind the same APPLE_HEALTH
    // source: the writer-bucket key (source, deviceType) keeps them apart,
    // and the annotation carries the device type so the UI can label both.
    const rows: SleepStageRow[] = [
      writerRow(
        "2026-06-04T00:30:00.000Z",
        "CORE",
        300,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T03:00:00.000Z",
        "DEEP",
        90,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow("2026-06-04T05:00:00.000Z", "REM", 65, "APPLE_HEALTH", "watch"),
      writerRow(
        "2026-06-04T05:30:00.000Z",
        "ASLEEP",
        615,
        "APPLE_HEALTH",
        "phone",
      ),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].asleepMinutes).toBe(455);
    expect(sessions[0].sourceDiscrepancy).toEqual({
      deltaMinutes: 160,
      sources: [
        { source: "APPLE_HEALTH", deviceType: "phone", asleepMinutes: 615 },
        { source: "APPLE_HEALTH", deviceType: "watch", asleepMinutes: 455 },
      ],
    });
  });
});

describe("night-level source discrepancy (dashboard path)", () => {
  // Same fixture as the session-level suite: granular Apple (455 asleep)
  // next to a bare Withings aggregate claiming 615 for the same overnight
  // session.
  const discrepantOvernight: SleepStageRow[] = [
    srcRow("2026-06-04T00:30:00.000Z", "CORE", 300, "APPLE_HEALTH"),
    srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
    srcRow("2026-06-04T05:00:00.000Z", "REM", 65, "APPLE_HEALTH"),
    srcRow("2026-06-04T05:30:00.000Z", "ASLEEP", 615, "WITHINGS"),
  ];

  it("carries the main session's annotation on the night without changing the served total", () => {
    const nights = reconstructSleepNights(discrepantOvernight, "UTC");
    expect(nights).toHaveLength(1);
    // The served total stays the winning writer's number — the annotation
    // observes, the writer collapse decides.
    expect(nights[0].asleepMinutes).toBe(455);
    expect(nights[0].sourceDiscrepancy).toEqual({
      deltaMinutes: 160,
      sources: [
        { source: "WITHINGS", deviceType: null, asleepMinutes: 615 },
        { source: "APPLE_HEALTH", deviceType: null, asleepMinutes: 455 },
      ],
    });
    // The dashboard reads the night through `summarizeSleepNights`.
    const { latestNight } = summarizeSleepNights(discrepantOvernight, "UTC");
    expect(latestNight?.asleepMinutes).toBe(455);
    expect(latestNight?.sourceDiscrepancy).toEqual(nights[0].sourceDiscrepancy);
  });

  it("ignores a nap-only disagreement — sessions never cross-compare", () => {
    // Clean single-writer overnight (455 asleep), then a same-wake-day nap
    // (> 3 h gap) where two writers clearly disagree (120 vs 200 → delta 80
    // > 45 min and > 20 % of 200). The nap's session-level annotation must
    // NOT leak onto the night: the night's marker reflects the MAIN
    // (overnight) session only.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T00:30:00.000Z", "CORE", 300, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
      srcRow("2026-06-04T05:00:00.000Z", "REM", 65, "APPLE_HEALTH"),
      srcRow("2026-06-04T15:00:00.000Z", "CORE", 120, "APPLE_HEALTH"),
      srcRow("2026-06-04T15:00:00.000Z", "ASLEEP", 200, "WITHINGS"),
    ];
    // Sanity: the nap session itself IS flagged at session level.
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(2);
    expect(sessions[1].sourceDiscrepancy).not.toBeNull();

    const { latestNight } = summarizeSleepNights(rows, "UTC");
    expect(latestNight?.night).toBe("2026-06-04");
    // Overnight (455) outweighs the nap (120) → main session is clean.
    expect(latestNight?.sourceDiscrepancy).toBeNull();
  });

  it("stays null for a single-writer night", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T00:30:00.000Z", "CORE", 300, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
    ];
    const { latestNight } = summarizeSleepNights(rows, "UTC");
    expect(latestNight?.sourceDiscrepancy).toBeNull();
  });
});

/**
 * Overlapping spans within ONE writer. A device can write the SAME period
 * twice — an original envelope and a corrected one, same start, later end,
 * distinct external ids. Both rows belong to the same writer, so the
 * writer collapse keeps both, and adding their minute counts reports the
 * period twice.
 */
describe("overlapping spans within one writer", () => {
  /** 16:06:00Z → 02:09:59Z — the superseded envelope. */
  const IN_BED_ORIGINAL = 603 + 59 / 60;
  /** 16:06:00Z → 02:18:59Z — the corrected envelope, same start. */
  const IN_BED_REVISED = 612 + 59 / 60;

  /**
   * One reported night: two IN_BED rows sharing a start, four staged
   * segments inside the envelope, one AWAKE bout mid-sleep. Raw-summing the
   * two envelopes yields 1217 min (20 h 17 min) against a 613 min (10 h 13
   * min) union.
   */
  function revisedEnvelopeNight(): SleepStageRow[] {
    return [
      srcRow(
        "2026-07-25T02:09:59.000Z",
        "IN_BED",
        IN_BED_ORIGINAL,
        "APPLE_HEALTH",
      ),
      srcRow(
        "2026-07-25T02:18:59.000Z",
        "IN_BED",
        IN_BED_REVISED,
        "APPLE_HEALTH",
      ),
      srcRow("2026-07-24T21:55:42.000Z", "CORE", 319.7, "APPLE_HEALTH"),
      srcRow("2026-07-24T23:30:36.000Z", "DEEP", 94.9, "APPLE_HEALTH"),
      srcRow("2026-07-24T23:37:31.200Z", "AWAKE", 6.92, "APPLE_HEALTH"),
      srcRow("2026-07-25T01:53:25.200Z", "REM", 135.9, "APPLE_HEALTH"),
    ];
  }

  it("reports the union, not the sum, when a revised in-bed row supersedes the original", () => {
    const sessions = reconstructSleepSessions(revisedEnvelopeNight(), "UTC");
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // Headline and legend are ONE number: 613, never 1217.
    expect(Math.round(s.inBedMinutes!)).toBe(613);
    expect(Math.round(s.stages.IN_BED!)).toBe(613);
    expect(s.stages.IN_BED).toBe(s.inBedMinutes);
    // The staged totals of that night were never the defect.
    expect(Math.round(s.stages.CORE!)).toBe(320);
    expect(Math.round(s.stages.DEEP!)).toBe(95);
    expect(Math.round(s.stages.REM!)).toBe(136);
    expect(Math.round(s.stages.AWAKE!)).toBe(7);
    expect(Math.round(s.asleepMinutes)).toBe(551);
    expect(s.awakenings).toBe(1);
  });

  it("draws the revised in-bed envelope as ONE hypnogram segment", () => {
    const sessions = reconstructSleepSessions(revisedEnvelopeNight(), "UTC");
    const inBed = sessions[0].segments.filter((seg) => seg.stage === "IN_BED");
    expect(inBed).toHaveLength(1);
    expect(inBed[0].start.toISOString()).toBe("2026-07-24T16:06:00.000Z");
    expect(inBed[0].end.toISOString()).toBe("2026-07-25T02:18:59.000Z");
    // Five bars, not six: the superseded envelope is gone, not stacked.
    expect(sessions[0].segments).toHaveLength(5);
  });

  it("carries the same union onto the night-level headline and legend", () => {
    const nights = reconstructSleepNights(revisedEnvelopeNight(), "UTC");
    expect(nights).toHaveLength(1);
    expect(Math.round(nights[0].inBedMinutes!)).toBe(613);
    expect(nights[0].stages.IN_BED).toBe(nights[0].inBedMinutes);
    expect(Math.round(nights[0].stages.CORE!)).toBe(320);
    expect(Math.round(nights[0].asleepMinutes)).toBe(551);
  });

  it("merges a re-exported CORE span instead of counting it twice", () => {
    // The same correction shape on a sleep stage rather than the envelope:
    // 22:00 → 00:00 superseded by 22:00 → 00:30.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T00:00:00.000Z", "CORE", 120, "APPLE_HEALTH"),
      srcRow("2026-06-04T00:30:00.000Z", "CORE", 150, "APPLE_HEALTH"),
      srcRow("2026-06-04T02:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions[0].stages.CORE).toBe(150);
    expect(sessions[0].asleepMinutes).toBe(240);
    expect(sessions[0].segments.filter((s) => s.stage === "CORE")).toHaveLength(
      1,
    );
  });

  it("keeps two TOUCHING awake bouts separate — touching is not overlap", () => {
    // Consecutive AWAKE spans (one ends exactly where the next starts)
    // describe two bouts, not one doubled export. Coalescing them would
    // silently drop a mid-sleep awakening.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T00:00:00.000Z", "CORE", 120, "APPLE_HEALTH"),
      srcRow("2026-06-04T00:10:00.000Z", "AWAKE", 10, "APPLE_HEALTH"),
      srcRow("2026-06-04T00:20:00.000Z", "AWAKE", 10, "APPLE_HEALTH"),
      srcRow("2026-06-04T02:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions[0].stages.AWAKE).toBe(20);
    expect(
      sessions[0].segments.filter((s) => s.stage === "AWAKE"),
    ).toHaveLength(2);
    expect(sessions[0].awakenings).toBe(2);
  });

  it("leaves a summary-shaped writer's nested stage spans alone", () => {
    // WHOOP stamps every stage total on the sleep END instant, so its spans
    // nest inside one another by design. Arbitrating across stages would
    // collapse the night to its longest stage — the totals must survive.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T06:00:00.000Z", "CORE", 200, "WHOOP"),
      srcRow("2026-06-04T06:00:00.000Z", "DEEP", 60, "WHOOP"),
      srcRow("2026-06-04T06:00:00.000Z", "REM", 80, "WHOOP"),
      srcRow("2026-06-04T06:00:00.000Z", "AWAKE", 15, "WHOOP"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions[0].stages.CORE).toBe(200);
    expect(sessions[0].stages.DEEP).toBe(60);
    expect(sessions[0].stages.REM).toBe(80);
    expect(sessions[0].asleepMinutes).toBe(340);
  });
});

describe("in-bed envelope across writers", () => {
  it("unions two partially overlapping writer envelopes into headline AND legend", () => {
    const rows: SleepStageRow[] = [
      writerRow(
        "2026-06-04T02:00:00.000Z",
        "CORE",
        200,
        "APPLE_HEALTH",
        "watch",
      ),
      // Watch 22:00 → 04:00, phone 00:00 → 06:00: union 22:00 → 06:00.
      writerRow(
        "2026-06-04T04:00:00.000Z",
        "IN_BED",
        360,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T06:00:00.000Z",
        "IN_BED",
        360,
        "APPLE_HEALTH",
        "phone",
      ),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions[0].inBedMinutes).toBe(480);
    expect(sessions[0].stages.IN_BED).toBe(480);
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights[0].stages.IN_BED).toBe(nights[0].inBedMinutes);
  });

  it("keeps the legend on the headline when only a LOSING writer knows the envelope", () => {
    // The watch wins the night on stage richness and writes no IN_BED row;
    // the phone's bedtime detection holds the night's only envelope. The
    // legend must report the envelope the headline reports, not nothing.
    const rows: SleepStageRow[] = [
      writerRow(
        "2026-06-04T00:30:00.000Z",
        "CORE",
        120,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T02:30:00.000Z",
        "DEEP",
        60,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow("2026-06-04T04:00:00.000Z", "REM", 80, "APPLE_HEALTH", "watch"),
      writerRow(
        "2026-06-04T04:30:00.000Z",
        "IN_BED",
        460,
        "APPLE_HEALTH",
        "phone",
      ),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions[0].inBedMinutes).toBe(460);
    expect(sessions[0].stages.IN_BED).toBe(460);
  });

  it("sums two DISJOINT in-bed intervals of one session without merging them", () => {
    // Two separate in-bed windows less than the session gap apart: the
    // envelope is the sum of the two unions, not the span between them.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T00:00:00.000Z", "IN_BED", 60, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:00:00.000Z", "CORE", 120, "APPLE_HEALTH"),
      srcRow("2026-06-04T05:00:00.000Z", "IN_BED", 60, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].inBedMinutes).toBe(120);
    expect(sessions[0].stages.IN_BED).toBe(120);
    expect(
      sessions[0].segments.filter((s) => s.stage === "IN_BED"),
    ).toHaveLength(2);
  });

  it("reports no in-bed signal at all when no IN_BED row exists", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T02:00:00.000Z", "CORE", 120, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 60, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions[0].inBedMinutes).toBeNull();
    expect(sessions[0].stages.IN_BED).toBeUndefined();
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights[0].inBedMinutes).toBeNull();
    expect(nights[0].stages.IN_BED).toBeUndefined();
  });
});

/**
 * The invariant, checked over generated shapes rather than hand-picked ones:
 * every stage total is the MEASURE OF THE UNION of that stage's spans, so no
 * stage total can exceed the session's own envelope, and `stages.IN_BED` is
 * the same number as `inBedMinutes` by construction.
 */
describe("stage-total invariant over generated sessions", () => {
  /** Deterministic 32-bit PRNG — a failing seed is reproducible. */
  function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
  }

  /** Total minutes covered by the union of a set of [start, end) spans. */
  function unionMinutes(spans: Array<{ start: number; end: number }>): number {
    if (spans.length === 0) return 0;
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    let total = 0;
    let curStart = sorted[0].start;
    let curEnd = sorted[0].end;
    for (const span of sorted.slice(1)) {
      if (span.start <= curEnd) {
        if (span.end > curEnd) curEnd = span.end;
      } else {
        total += curEnd - curStart;
        curStart = span.start;
        curEnd = span.end;
      }
    }
    return (total + (curEnd - curStart)) / 60_000;
  }

  const GENERATED_STAGES: SleepStage[] = ["CORE", "DEEP", "REM", "AWAKE"];
  const BASE = Date.parse("2026-06-03T20:00:00.000Z");

  it("holds for 500 randomly overlapping single-writer sessions", () => {
    const rand = prng(20_260_724);
    for (let round = 0; round < 500; round++) {
      // One IN_BED row spans the whole window so every generated span lands
      // in ONE session regardless of the gaps between the staged rows.
      const rows: SleepStageRow[] = [
        srcRow(
          new Date(BASE + 720 * 60_000).toISOString(),
          "IN_BED",
          720,
          "APPLE_HEALTH",
        ),
      ];
      // A second, deliberately overlapping in-bed envelope on most rounds —
      // the corrected-export shape.
      if (rand() < 0.7) {
        const extra = 60 + Math.floor(rand() * 660);
        rows.push(
          srcRow(
            new Date(BASE + (extra + 30) * 60_000).toISOString(),
            "IN_BED",
            extra,
            "APPLE_HEALTH",
          ),
        );
      }
      const spanCount = 2 + Math.floor(rand() * 8);
      for (let i = 0; i < spanCount; i++) {
        const stage = GENERATED_STAGES[Math.floor(rand() * 4)];
        const start = Math.floor(rand() * 600);
        const minutes = 5 + Math.floor(rand() * 175);
        rows.push(
          srcRow(
            new Date(BASE + (start + minutes) * 60_000).toISOString(),
            stage,
            minutes,
            "APPLE_HEALTH",
          ),
        );
      }

      const sessions = reconstructSleepSessions(rows, "UTC");
      expect(sessions).toHaveLength(1);
      const s = sessions[0];

      // Independently recompute the spans of the raw rows.
      const spansOf = (predicate: (r: SleepStageRow) => boolean) =>
        rows.filter(predicate).map((r) => ({
          start: r.measuredAt.getTime() - r.value * 60_000,
          end: r.measuredAt.getTime(),
        }));
      const envelope = unionMinutes(spansOf(() => true));

      for (const [stage, total] of Object.entries(s.stages)) {
        // No stage total exceeds the session's union envelope…
        expect(total).toBeLessThanOrEqual(envelope);
        // …and each one IS the union measure of that stage's own spans.
        expect(total).toBe(
          stage === "IN_BED"
            ? Math.round(
                unionMinutes(spansOf((r) => r.sleepStage === "IN_BED")),
              )
            : unionMinutes(spansOf((r) => r.sleepStage === stage)),
        );
      }
      // The legend never contradicts the headline.
      expect(s.stages.IN_BED).toBe(s.inBedMinutes);
      expect(s.awakeMinutes).toBe(s.stages.AWAKE ?? null);
      // Time asleep is the same merged arithmetic as the legend it sits on.
      const granular = ["CORE", "DEEP", "REM"].reduce(
        (sum, stage) => sum + (s.stages[stage as SleepStage] ?? 0),
        0,
      );
      expect(s.asleepMinutes).toBe(granular);
      // Deliberately NOT asserted: that the stage totals SUM to no more than
      // the envelope. Two stages describing the same minute is a contest, not
      // a doubled export, and the writer collapse is the mechanism that
      // settles it — arbitrating again here would collapse every
      // summary-shaped writer (WHOOP / Polar stamp all stage totals on the
      // sleep END instant, so their spans nest by design) to its longest
      // stage. The per-stage bound above is what the merge can honestly
      // guarantee, and it is what the contradictory legend needed.
    }
  });
});

/**
 * #1419 — whether a night's spans carry the ORDER of its stages or only their
 * totals is read from the spans' shape, once, on the server. The fixtures are
 * the shapes the integrations write: a daily sleep summary stamping every
 * stage total on the wake instant (Garmin, Oura's fallback), the ingest
 * builder's back-to-back layout (WHOOP, Polar), and a measured night that
 * alternates through its cycles (Apple Health, Withings, Oura's hypnogram).
 */
describe("stage order from the spans' shape (#1419)", () => {
  const WAKE = "2026-06-04T05:00:00.000Z";

  /** Garmin's daily summary: four stage totals, all on the wake instant. */
  function garminSummary(source: MeasurementSource = "GARMIN") {
    return [
      writerRow(WAKE, "CORE", 250, source, "watch"),
      writerRow(WAKE, "DEEP", 40, source, "watch"),
      writerRow(WAKE, "REM", 95, source, "watch"),
      writerRow(WAKE, "AWAKE", 45, source, "watch"),
    ];
  }

  /** The same night as a measured series (00:50 → 05:00), one awakening. */
  function measuredNight(source: MeasurementSource = "APPLE_HEALTH") {
    return [
      writerRow("2026-06-04T02:00:00.000Z", "CORE", 70, source, "watch"),
      writerRow("2026-06-04T02:40:00.000Z", "DEEP", 40, source, "watch"),
      writerRow("2026-06-04T03:10:00.000Z", "REM", 30, source, "watch"),
      writerRow("2026-06-04T03:20:00.000Z", "AWAKE", 10, source, "watch"),
      writerRow("2026-06-04T04:30:00.000Z", "CORE", 70, source, "watch"),
      writerRow("2026-06-04T05:00:00.000Z", "REM", 30, source, "watch"),
    ];
  }

  /** WHOOP's ingest layout of the night's totals: AWAKE, CORE, DEEP, REM. */
  function whoopLayout() {
    return [
      srcRow("2026-06-04T01:00:00.000Z", "AWAKE", 10, "WHOOP"),
      srcRow("2026-06-04T03:20:00.000Z", "CORE", 140, "WHOOP"),
      srcRow("2026-06-04T04:00:00.000Z", "DEEP", 40, "WHOOP"),
      srcRow("2026-06-04T05:00:00.000Z", "REM", 60, "WHOOP"),
      srcRow("2026-06-04T05:00:00.000Z", "IN_BED", 250, "WHOOP"),
    ];
  }

  it("flags a Garmin night of stage totals and counts no awakening in it", () => {
    const sessions = reconstructSleepSessions(garminSummary(), "UTC");
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.source).toBe("GARMIN");
    expect(s.reconstructed).toBe(true);
    // Sorted by derived start, the 45-minute AWAKE total falls between REM
    // and DEEP; an awakening read off that order would be invented.
    expect(s.awakenings).toBe(0);
    // The totals themselves are what the night does know.
    expect(s.asleepMinutes).toBe(385);
    expect(s.stages).toMatchObject({ CORE: 250, DEEP: 40, REM: 95, AWAKE: 45 });
  });

  it("flags Oura's stage-total fallback the same way", () => {
    const rows = [
      srcRow(WAKE, "CORE", 250, "OURA"),
      srcRow(WAKE, "DEEP", 60, "OURA"),
      srcRow(WAKE, "REM", 90, "OURA"),
    ];
    expect(reconstructSleepSessions(rows, "UTC")[0].reconstructed).toBe(true);
  });

  it("flags totals stamped on one onset instant", () => {
    // Every span starts at 23:00; the ends only say how long each lasted.
    const rows = [
      srcRow("2026-06-04T03:00:00.000Z", "CORE", 240, "GOOGLE_HEALTH"),
      srcRow("2026-06-04T00:30:00.000Z", "DEEP", 90, "GOOGLE_HEALTH"),
      srcRow("2026-06-04T00:20:00.000Z", "REM", 80, "GOOGLE_HEALTH"),
    ];
    expect(reconstructSleepSessions(rows, "UTC")[0].reconstructed).toBe(true);
  });

  it("flags the ingest layout of WHOOP totals, IN_BED envelope included", () => {
    const s = reconstructSleepSessions(whoopLayout(), "UTC")[0];
    expect(s.source).toBe("WHOOP");
    expect(s.reconstructed).toBe(true);
    expect(s.awakenings).toBe(0);
  });

  it("keeps a measured night a timeline, with its awakening", () => {
    const s = reconstructSleepSessions(measuredNight(), "UTC")[0];
    expect(s.source).toBe("APPLE_HEALTH");
    expect(s.reconstructed).toBe(false);
    expect(s.awakenings).toBe(1);
  });

  it("decides from the shape, not from the source's name", () => {
    expect(
      reconstructSleepSessions(garminSummary("APPLE_HEALTH"), "UTC")[0]
        .reconstructed,
    ).toBe(true);
    expect(
      reconstructSleepSessions(measuredNight("GARMIN"), "UTC")[0].reconstructed,
    ).toBe(false);
  });

  it("serves the measured night when Garmin's totals and its Apple Health copy describe the same sleep", () => {
    // GARMIN outranks APPLE_HEALTH on the default sleep ladder and both carry
    // all three granular stages, so only the shape can decide.
    const s = reconstructSleepSessions(
      [...garminSummary(), ...measuredNight()],
      "UTC",
    );
    expect(s).toHaveLength(1);
    expect(s[0].source).toBe("APPLE_HEALTH");
    expect(s[0].reconstructed).toBe(false);
    expect(s[0].asleepMinutes).toBe(240);
    expect(s[0].awakenings).toBe(1);
    expect(s[0].segments).toHaveLength(6);
  });

  it("serves the measured night over a higher-ranked layout of totals", () => {
    // WHOOP tops the default ladder and its layout has distinct instants, so
    // an instant count alone let it win and drew its invented order.
    const s = reconstructSleepSessions(
      [...whoopLayout(), ...measuredNight()],
      "UTC",
    );
    expect(s).toHaveLength(1);
    expect(s[0].source).toBe("APPLE_HEALTH");
    expect(s[0].reconstructed).toBe(false);
    // The in-bed envelope still unions across writers.
    expect(s[0].inBedMinutes).toBe(250);
  });

  it("keeps the totals when the only other writer knows no stages", () => {
    const rows = [
      ...garminSummary(),
      writerRow(WAKE, "ASLEEP", 380, "APPLE_HEALTH", "phone"),
      writerRow(
        "2026-06-04T05:10:00.000Z",
        "IN_BED",
        420,
        "APPLE_HEALTH",
        "phone",
      ),
    ];
    const s = reconstructSleepSessions(rows, "UTC")[0];
    expect(s.source).toBe("GARMIN");
    expect(s.reconstructed).toBe(true);
    expect(s.inBedMinutes).toBe(420);
  });

  it("keeps Garmin's totals over the first lone span of a sync still arriving", () => {
    const rows = [
      ...garminSummary(),
      writerRow(
        "2026-06-04T02:00:00.000Z",
        "CORE",
        70,
        "APPLE_HEALTH",
        "watch",
      ),
    ];
    const s = reconstructSleepSessions(rows, "UTC")[0];
    expect(s.source).toBe("GARMIN");
    expect(s.asleepMinutes).toBe(385);
  });

  it("carries the measured night onto the night-level totals as well", () => {
    const nights = reconstructSleepNights(
      [...whoopLayout(), ...measuredNight()],
      "UTC",
    );
    expect(nights).toHaveLength(1);
    expect(nights[0].asleepMinutes).toBe(240);
  });
});
