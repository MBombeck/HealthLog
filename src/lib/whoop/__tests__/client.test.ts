import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WHOOP_PAGE_LIMIT,
  fetchBodyMeasurement,
  fetchRecoveryByCycleId,
  fetchSleepById,
  fetchWorkoutById,
  fetchCycleById,
  fetchCycles,
  fetchProfile,
  fetchRecoveries,
  fetchSleeps,
  fetchWorkouts,
} from "../client";
import {
  KJ_TO_KCAL,
  WHOOP_FIELD_MAP,
  mapCycle,
  mapRecovery,
  mapSleep,
} from "@/lib/whoop/map";
import {
  type WhoopCycle,
  type WhoopRecovery,
  type WhoopSleep,
} from "@/lib/whoop/wire-types";
import { WHOOP_OAUTH_SCOPE } from "@/lib/whoop/oauth";
import { WhoopApiError } from "../response-classifier";
import { whoopOAuth } from "../oauth";

const CREDS = { clientId: "cid", clientSecret: "csecret" };

/** Stub global fetch with a queue of `{ status, body }` responses. */
function installFetchMock(pages: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const page = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    return {
      status: page.status,
      json: async () => page.body,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getAuthorizationUrl", () => {
  it("builds the v2 authorize URL with the offline scope and state", () => {
    const url = whoopOAuth.authorizationUrl("nonce123", CREDS);
    expect(url).toContain("api.prod.whoop.com/oauth/oauth2/auth");
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("state=nonce123");
    // URLSearchParams encodes the space-separated scope with `+`; compare the
    // parsed `scope` param back to the canonical constant.
    const scope = new URL(url).searchParams.get("scope");
    expect(scope).toBe(WHOOP_OAUTH_SCOPE);
    expect(WHOOP_OAUTH_SCOPE).toContain("offline");
  });
});

describe("token exchange + refresh", () => {
  it("exchanges an authorization code for a token pair", async () => {
    installFetchMock([
      {
        status: 200,
        body: {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "offline read:recovery",
        },
      },
    ]);
    const tok = await whoopOAuth.exchange("code", CREDS);
    expect(tok.access_token).toBe("at");
    expect(tok.refresh_token).toBe("rt");
    expect(tok.expires_in).toBe(3600);
  });

  it("re-requests the offline scope on refresh so a new refresh token rotates in", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: { access_token: "at2", refresh_token: "rt2", expires_in: 3600 },
      },
    ]);
    const tok = await whoopOAuth.refresh("rt1", CREDS);
    expect(tok.refresh_token).toBe("rt2");
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("scope=offline");
  });

  it("throws a classified WhoopApiError on a 401 token response", async () => {
    installFetchMock([{ status: 401, body: { error: "invalid_grant" } }]);
    await expect(whoopOAuth.exchange("bad", CREDS)).rejects.toMatchObject({
      name: "WhoopApiError",
      classification: "reauth_required",
    });
  });
});

describe("fetchCollection pagination", () => {
  it("walks next_token across pages and concatenates records", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: { records: [{ id: 1 }, { id: 2 }], next_token: "t1" },
      },
      { status: 200, body: { records: [{ id: 3 }], next_token: null } },
    ]);
    const recs = await fetchRecoveries("at");
    expect(recs.map((r) => (r as unknown as { id: number }).id)).toEqual([
      1, 2, 3,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Page 1 carries no nextToken; page 2 forwards the cursor.
    const [url1] = fetchMock.mock.calls[0] as unknown as [string];
    const [url2] = fetchMock.mock.calls[1] as unknown as [string];
    expect(url1).toContain(`limit=${WHOOP_PAGE_LIMIT}`);
    expect(url1).not.toContain("nextToken");
    expect(url2).toContain("nextToken=t1");
  });

  it("stops on a single page when next_token is absent", async () => {
    const fetchMock = installFetchMock([
      { status: 200, body: { records: [{ id: 1 }] } },
    ]);
    await fetchRecoveries("at");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ends on an empty next_token without reading the first page again", async () => {
    const fetchMock = installFetchMock([
      { status: 200, body: { records: [{ id: 1 }], next_token: "" } },
      { status: 200, body: { records: [{ id: 1 }], next_token: "" } },
    ]);
    const recs = await fetchRecoveries("at");
    expect(recs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws WhoopApiError when a page returns 500", async () => {
    installFetchMock([{ status: 500, body: { error: "boom" } }]);
    await expect(fetchRecoveries("at")).rejects.toBeInstanceOf(WhoopApiError);
  });

  it("forwards start/end window params on collection reads", async () => {
    const fetchMock = installFetchMock([
      { status: 200, body: { records: [] } },
    ]);
    await fetchSleeps("at", {
      start: new Date("2026-06-01T00:00:00.000Z"),
      end: new Date("2026-06-02T00:00:00.000Z"),
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/v2/activity/sleep");
    expect(url).toContain("start=2026-06-01T00%3A00%3A00.000Z");
    expect(url).toContain("end=2026-06-02T00%3A00%3A00.000Z");
  });
});

describe("collection endpoint paths", () => {
  it("hits the documented v2 path for each collection", async () => {
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => fetchCycles("at"), "/v2/cycle"],
      [() => fetchWorkouts("at"), "/v2/activity/workout"],
    ];
    for (const [call, path] of cases) {
      const fetchMock = installFetchMock([
        { status: 200, body: { records: [] } },
      ]);
      await call();
      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toContain(path);
      vi.unstubAllGlobals();
    }
  });
});

describe("single-object endpoints", () => {
  it("fetches the body measurement (max_heart_rate is a profile constant)", async () => {
    installFetchMock([
      {
        status: 200,
        body: { height_meter: 1.8, weight_kilogram: 80, max_heart_rate: 190 },
      },
    ]);
    const body = await fetchBodyMeasurement("at");
    expect(body.weight_kilogram).toBe(80);
    expect(body.max_heart_rate).toBe(190);
  });

  it("fetches the basic profile", async () => {
    installFetchMock([{ status: 200, body: { user_id: 42, first_name: "A" } }]);
    const profile = await fetchProfile("at");
    expect(profile.user_id).toBe(42);
  });

  it("throws a classified error on a 401 single-object read", async () => {
    installFetchMock([{ status: 401, body: null }]);
    await expect(fetchProfile("bad")).rejects.toMatchObject({
      classification: "reauth_required",
    });
  });
});

describe("fetch-by-id (webhook-driven single-record refresh)", () => {
  it("resolves one record at the documented v2 single-record path", async () => {
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => fetchSleepById("at", "s1"), "/v2/activity/sleep/s1"],
      [() => fetchWorkoutById("at", "w1"), "/v2/activity/workout/w1"],
      [() => fetchCycleById("at", "123"), "/v2/cycle/123"],
      [() => fetchRecoveryByCycleId("at", "123"), "/v2/cycle/123/recovery"],
    ];
    for (const [call, path] of cases) {
      const fetchMock = installFetchMock([{ status: 200, body: { id: "x" } }]);
      await call();
      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toContain(path);
      vi.unstubAllGlobals();
    }
  });

  it("returns the single record body (one workout by id)", async () => {
    installFetchMock([
      { status: 200, body: { id: "w1", start: "s", end: "e" } },
    ]);
    const w = await fetchWorkoutById("at", "w1");
    expect(w.id).toBe("w1");
  });

  it("url-encodes a resource id with reserved characters", async () => {
    const fetchMock = installFetchMock([{ status: 200, body: { id: "x" } }]);
    await fetchWorkoutById("at", "a/b?c");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/v2/activity/workout/a%2Fb%3Fc");
  });
});

describe("mapRecovery", () => {
  const base: WhoopRecovery = {
    cycle_id: 1,
    sleep_id: "sleep-uuid",
    user_id: 42,
    created_at: "2026-06-01T06:00:00.000Z",
    updated_at: "2026-06-01T07:00:00.000Z",
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: 66,
      resting_heart_rate: 52,
      hrv_rmssd_milli: 48.7,
      spo2_percentage: 97,
      skin_temp_celsius: 33.4,
    },
  };

  it("maps recovery score, RMSSD (not SDNN), RHR, spo2, skin-temp", () => {
    const rows = mapRecovery(base);
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(byType.RECOVERY_SCORE?.value).toBe(66);
    expect(byType.HRV_RMSSD?.value).toBe(48.7);
    expect(byType.HRV_RMSSD?.unit).toBe("ms");
    // RMSSD must never relabel as the SDNN HEART_RATE_VARIABILITY.
    expect(byType.HEART_RATE_VARIABILITY).toBeUndefined();
    expect(byType.RESTING_HEART_RATE?.value).toBe(52);
    expect(byType.OXYGEN_SATURATION?.value).toBe(97);
    expect(byType.SKIN_TEMPERATURE?.value).toBe(33.4);
    // measuredAt tracks updated_at (the re-score timestamp).
    expect(byType.RECOVERY_SCORE?.measuredAt.toISOString()).toBe(
      "2026-06-01T07:00:00.000Z",
    );
    // Every row carries a distinct field-tag for the externalId.
    expect(new Set(rows.map((r) => r.fieldTag)).size).toBe(rows.length);
  });

  it("emits nothing for an unscored recovery (score null)", () => {
    expect(mapRecovery({ ...base, score: null })).toEqual([]);
  });

  it("omits optional spo2 / skin-temp when absent", () => {
    const rows = mapRecovery({
      ...base,
      score: {
        ...base.score!,
        spo2_percentage: undefined,
        skin_temp_celsius: undefined,
      },
    });
    expect(rows.some((r) => r.type === "OXYGEN_SATURATION")).toBe(false);
    expect(rows.some((r) => r.type === "SKIN_TEMPERATURE")).toBe(false);
  });
});

describe("mapSleep", () => {
  const base: WhoopSleep = {
    id: "sleep-uuid",
    user_id: 42,
    created_at: "2026-06-01T05:00:00.000Z",
    updated_at: "2026-06-01T07:00:00.000Z",
    start: "2026-05-31T23:00:00.000Z",
    end: "2026-06-01T07:00:00.000Z",
    nap: false,
    score_state: "SCORED",
    score: {
      stage_summary: {
        total_in_bed_time_milli: 28_800_000, // 480 min
        total_awake_time_milli: 1_800_000, // 30 min
        total_light_sleep_time_milli: 14_400_000, // 240 min
        total_slow_wave_sleep_time_milli: 5_400_000, // 90 min
        total_rem_sleep_time_milli: 7_200_000, // 120 min
      },
      sleep_needed: {
        baseline_milli: 27_000_000, // 450 min
        need_from_sleep_debt_milli: 1_800_000, // 30 min
        need_from_recent_strain_milli: 600_000, // 10 min
        need_from_recent_nap_milli: 0,
      },
      respiratory_rate: 15.2,
      sleep_performance_percentage: 88,
      sleep_efficiency_percentage: 93.5,
      sleep_consistency_percentage: 71,
    },
  };

  it("maps per-stage SLEEP_DURATION rows (ms→min) with sleepStage", () => {
    const rows = mapSleep(base);
    const dur = rows.filter((r) => r.type === "SLEEP_DURATION");
    // One asleep/awake row per reconstructed segment + one IN_BED envelope. The
    // per-stage TOTALS are unchanged (the reconstruction only reorders timing).
    const minutesByStage: Record<string, number> = {};
    for (const r of dur) {
      minutesByStage[r.sleepStage!] =
        (minutesByStage[r.sleepStage!] ?? 0) + r.value;
    }
    expect(minutesByStage.CORE).toBe(240); // light → CORE
    expect(minutesByStage.DEEP).toBe(90); // slow-wave → DEEP
    expect(minutesByStage.REM).toBe(120);
    expect(minutesByStage.AWAKE).toBe(30);
    expect(minutesByStage.IN_BED).toBe(480);
    expect(dur.every((r) => r.unit === "minutes")).toBe(true);
  });

  it("reconstructs an ordered, contiguous, non-overlapping per-segment timeline from sleep ONSET", () => {
    const segs = mapSleep(base)
      .filter((r) => r.type === "SLEEP_DURATION" && r.sleepStage !== "IN_BED")
      .map((r) => ({
        stage: r.sleepStage,
        end: r.measuredAt.getTime(),
        start: r.measuredAt.getTime() - r.value * 60_000,
        reconstructed: r.reconstructed,
      }))
      .sort((a, b) => a.start - b.start);

    // AWAKE (lead) → CORE → DEEP → REM, laid back-to-back.
    expect(segs.map((s) => s.stage)).toEqual(["AWAKE", "CORE", "DEEP", "REM"]);
    // First segment starts at sleep ONSET (s.start), not the END edge.
    expect(segs[0].start).toBe(new Date(base.start).getTime());
    // Contiguous + non-overlapping: each segment's start == previous end.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].start).toBe(segs[i - 1].end);
    }
    // Distinct END instants — no stacking on the night's right edge.
    expect(new Set(segs.map((s) => s.end)).size).toBe(segs.length);
    // Every reconstructed row is flagged so the UI labels the night approximate.
    expect(segs.every((s) => s.reconstructed === true)).toBe(true);
  });

  it("emits IN_BED as a single un-reconstructed envelope row over [start, end]", () => {
    const inBed = mapSleep(base).filter((r) => r.sleepStage === "IN_BED");
    expect(inBed).toHaveLength(1);
    const r = inBed[0]!;
    expect(r.value).toBe(480);
    // measuredAt = sleep END → segmentOf resolves the span back to the window.
    expect(r.measuredAt.toISOString()).toBe(base.end);
    expect(r.reconstructed).toBeUndefined();
  });

  it("gives each reconstructed segment a distinct stage-tagged externalId", () => {
    const ids = mapSleep(base)
      .filter((r) => r.reconstructed)
      .map((r) => r.externalId);
    // One segment per stage — the tag alone keys the row. No positional index:
    // an index renumbered on a re-score whenever a stage's duration flipped
    // 0↔positive, minting fresh externalIds that double-counted the night.
    expect(ids).toEqual([
      "sleep-uuid:seg:sleep_awake",
      "sleep-uuid:seg:sleep_core",
      "sleep-uuid:seg:sleep_deep",
      "sleep-uuid:seg:sleep_rem",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps IDENTICAL externalIds across a re-score that flips a stage 0↔positive", () => {
    // First scoring: no awake time (the leading AWAKE segment is skipped).
    // Re-score of the SAME record: WHOOP now reports a positive awake block.
    // Under the retired indexed key the re-score renumbered CORE/DEEP/REM,
    // so the upsert inserted a second set instead of overwriting.
    const first = mapSleep({
      ...base,
      score: {
        ...base.score!,
        stage_summary: {
          ...base.score!.stage_summary,
          total_awake_time_milli: 0,
        },
      },
    });
    const rescored = mapSleep(base);

    const idsByStage = (rows: typeof first) =>
      new Map(
        rows
          .filter((r) => r.reconstructed)
          .map((r) => [r.sleepStage, r.externalId]),
      );
    const a = idsByStage(first);
    const b = idsByStage(rescored);
    for (const stage of ["CORE", "DEEP", "REM"] as const) {
      expect(b.get(stage)).toBe(a.get(stage));
    }
  });

  it("sums SLEEP_NEED components ms→min", () => {
    const need = mapSleep(base).find((r) => r.type === "SLEEP_NEED");
    expect(need?.value).toBe(490); // 450 + 30 + 10 + 0
    expect(need?.unit).toBe("minutes");
  });

  it("maps the SLEEP_* percentages and respiratory rate", () => {
    const byType = Object.fromEntries(mapSleep(base).map((r) => [r.type, r]));
    expect(byType.SLEEP_PERFORMANCE?.value).toBe(88);
    expect(byType.SLEEP_EFFICIENCY?.value).toBe(93.5);
    expect(byType.SLEEP_CONSISTENCY?.value).toBe(71);
    expect(byType.RESPIRATORY_RATE?.value).toBe(15.2);
    expect(byType.RESPIRATORY_RATE?.unit).toBe("breaths/min");
  });

  it("stamps the non-segment scores on sleep.end", () => {
    const need = mapSleep(base).find((r) => r.type === "SLEEP_NEED")!;
    expect(need.measuredAt.toISOString()).toBe("2026-06-01T07:00:00.000Z");
  });

  it("emits nothing for an unscored sleep", () => {
    expect(mapSleep({ ...base, score: null })).toEqual([]);
  });
});

describe("mapCycle", () => {
  const base: WhoopCycle = {
    id: 1234567890,
    user_id: 42,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T23:59:00.000Z",
    start: "2026-06-01T00:00:00.000Z",
    end: "2026-06-01T23:59:00.000Z",
    score_state: "SCORED",
    score: {
      strain: 12.34,
      kilojoule: 8765.4,
      average_heart_rate: 70,
      max_heart_rate: 180,
    },
  };

  it("maps DAY_STRAIN (not STRAIN_SCORE) and ENERGY_EXPENDITURE_KJ in native kJ", () => {
    const byType = Object.fromEntries(mapCycle(base).map((r) => [r.type, r]));
    expect(byType.DAY_STRAIN?.value).toBe(12.34);
    expect(byType.DAY_STRAIN?.unit).toBe("score");
    // WHOOP day-strain must never collide with the COMPUTED STRAIN_SCORE.
    expect(byType.STRAIN_SCORE).toBeUndefined();
    expect(byType.ENERGY_EXPENDITURE_KJ?.value).toBe(8765.4);
    expect(byType.ENERGY_EXPENDITURE_KJ?.unit).toBe("kJ");
    // measuredAt uses cycle.start.
    expect(byType.DAY_STRAIN?.measuredAt.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });

  it("emits nothing for an unscored cycle", () => {
    expect(mapCycle({ ...base, score: null })).toEqual([]);
  });
});

describe("WHOOP_FIELD_MAP", () => {
  it("documents the kJ→kcal factor for the workout energy path", () => {
    expect(WHOOP_FIELD_MAP["workout.score.kilojoule"]?.factor).toBeCloseTo(
      KJ_TO_KCAL,
    );
    expect(KJ_TO_KCAL).toBeCloseTo(1 / 4.184);
  });

  it("keeps day-strain and workout-strain off the COMPUTED STRAIN_SCORE type", () => {
    expect(WHOOP_FIELD_MAP["cycle.score.strain"]?.type).toBe("DAY_STRAIN");
    expect(WHOOP_FIELD_MAP["workout.score.strain"]?.type).toBe(
      "WORKOUT_STRAIN",
    );
  });
});
