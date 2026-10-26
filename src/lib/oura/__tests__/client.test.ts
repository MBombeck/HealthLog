import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchCardiovascularAge,
  fetchDailyCyclePhases,
  fetchReadiness,
  fetchResilience,
  fetchVo2Max,
} from "../client";
import {
  RESILIENCE_LEVELS,
  derivePeriodDaysFromCyclePhases,
  mapCardiovascularAge,
  mapDailyActivity,
  mapDailySleep,
  mapDailySpo2,
  mapReadiness,
  mapResilience,
  mapSleep,
  mapVo2Max,
} from "@/lib/oura/map";
import {
  type OuraCardiovascularAge,
  type OuraDailyActivity,
  type OuraDailySleep,
  type OuraDailySpo2,
  type OuraReadiness,
  type OuraResilience,
  type OuraSleep,
  type OuraVo2Max,
} from "@/lib/oura/wire-types";
import {
  OURA_OAUTH_LEGACY_TOKEN_URL,
  OURA_OAUTH_TOKEN_URL,
  getOuraCredentials,
  isAcceptedOuraIssuer,
} from "@/lib/oura/oauth";
import { OuraApiError } from "../response-classifier";
import { ouraOAuth, exchangeOuraCode } from "../oauth";

const CREDS = { clientId: "cid", clientSecret: "csecret" };

function installFetchMock(pages: Array<{ status: number; body?: unknown }>) {
  let i = 0;
  const fetchMock = vi.fn(async (...args: [string, RequestInit?]) => {
    void args;
    const page = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    return { status: page.status, json: async () => page.body ?? null };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.OURA_CLIENT_ID = "env-cid";
  process.env.OURA_CLIENT_SECRET = "env-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
  delete process.env.OURA_REDIRECT_URI;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getOuraCredentials", () => {
  it("reads env", () => {
    expect(getOuraCredentials()).toEqual({
      clientId: "env-cid",
      clientSecret: "env-secret",
    });
  });
  it("null when unconfigured", () => {
    delete process.env.OURA_CLIENT_SECRET;
    expect(getOuraCredentials()).toBeNull();
  });
});

describe("getAuthorizationUrl", () => {
  it("builds the Oura authorize URL", () => {
    const url = ouraOAuth.authorizationUrl("signed", CREDS);
    expect(url).toContain("cloud.ouraring.com/oauth/authorize");
    expect(url).toContain(
      "scope=daily+spo2+heart_health+stress+workout+heartrate+personal",
    );
    expect(url).toContain("state=signed");
  });
});

describe("exchangeCode / refreshAccessToken", () => {
  it("exchanges a code for an access + refresh token", async () => {
    installFetchMock([
      {
        status: 200,
        body: { access_token: "a", refresh_token: "r", expires_in: 86400 },
      },
    ]);
    const t = await exchangeOuraCode("code", CREDS);
    expect(t.access_token).toBe("a");
    expect(t.refresh_token).toBe("r");
  });

  it("rotates tokens on refresh", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: { access_token: "a2", refresh_token: "r2", expires_in: 86400 },
      },
    ]);
    const t = await ouraOAuth.refresh("r1", CREDS);
    expect(t.refresh_token).toBe("r2");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.body).toContain("grant_type=refresh_token");
  });

  it("throws OuraApiError on a 400 invalid_grant", async () => {
    installFetchMock([{ status: 400, body: { error: "invalid_grant" } }]);
    await expect(ouraOAuth.refresh("dead", CREDS)).rejects.toBeInstanceOf(
      OuraApiError,
    );
  });

  // A 2xx carrying an empty / non-JSON body used to be cast straight to the
  // token type, so callers dereferenced null and got an unclassified
  // TypeError. It must surface as a classified transient integration error.
  it("classifies a 2xx with an empty body instead of casting null", async () => {
    installFetchMock([{ status: 200, body: null }]);
    await expect(exchangeOuraCode("code", CREDS)).rejects.toMatchObject({
      classification: "transient",
      reason: "empty_token_body",
    });
  });

  it("classifies a 2xx with a non-object body on refresh", async () => {
    installFetchMock([{ status: 200, body: "not-json" }]);
    await expect(ouraOAuth.refresh("r1", CREDS)).rejects.toBeInstanceOf(
      OuraApiError,
    );
  });
});

/**
 * Oura moved its authorization server: apps from the current developer
 * portal get codes from moi.ouraring.com, which the documented
 * api.ouraring.com token endpoint refuses with 400 invalid_request. A code
 * works once, so the live endpoint is always asked first.
 */
describe("token endpoint order", () => {
  const MOI_ISS = "https://moi.ouraring.com/oauth/v2/ext/oauth-anonymous";
  const OK = {
    status: 200,
    body: { access_token: "a", refresh_token: "r", expires_in: 86400 },
  };
  const urls = (mock: ReturnType<typeof installFetchMock>) =>
    mock.mock.calls.map(([url]) => url);

  it("exchanges a code at the live endpoint, sending the secret in the body", async () => {
    const fetchMock = installFetchMock([OK]);
    await exchangeOuraCode("code", CREDS, MOI_ISS);
    expect(OURA_OAUTH_TOKEN_URL).toBe(
      "https://moi.ouraring.com/oauth/v2/ext/oauth-token",
    );
    expect(urls(fetchMock)).toEqual([OURA_OAUTH_TOKEN_URL]);
    const body = String(fetchMock.mock.calls[0]![1]!.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("client_id=cid");
    expect(body).toContain("client_secret=csecret");
  });

  it("never hands a code from the current server to the legacy endpoint", async () => {
    const fetchMock = installFetchMock([
      { status: 400, body: { error: "invalid_request" } },
      OK,
    ]);
    await expect(
      exchangeOuraCode("code", CREDS, MOI_ISS),
    ).rejects.toMatchObject({
      upstreamError: "invalid_request",
    });
    expect(urls(fetchMock)).toEqual([OURA_OAUTH_TOKEN_URL]);
    expect(urls(fetchMock)).not.toContain(OURA_OAUTH_LEGACY_TOKEN_URL);
  });

  it("asks the legacy endpoint only after the live one refused an older app's code", async () => {
    const fetchMock = installFetchMock([
      { status: 401, body: { error: "invalid_client" } },
      OK,
    ]);
    const t = await exchangeOuraCode("code", CREDS);
    expect(t.access_token).toBe("a");
    expect(urls(fetchMock)).toEqual([
      OURA_OAUTH_TOKEN_URL,
      OURA_OAUTH_LEGACY_TOKEN_URL,
    ]);
  });

  it("does not try the legacy endpoint once the live one accepted the code", async () => {
    const fetchMock = installFetchMock([OK]);
    await exchangeOuraCode("code", CREDS);
    expect(urls(fetchMock)).toEqual([OURA_OAUTH_TOKEN_URL]);
  });

  it("refreshes at the live endpoint first", async () => {
    const fetchMock = installFetchMock([OK]);
    await ouraOAuth.refresh("r1", CREDS);
    expect(urls(fetchMock)).toEqual([OURA_OAUTH_TOKEN_URL]);
  });

  it.each([
    [400, { error: "invalid_request" }],
    [404, null],
  ])(
    "falls back to the legacy endpoint on a %i from the live one",
    async (status, body) => {
      const fetchMock = installFetchMock([{ status, body }, OK]);
      const t = await ouraOAuth.refresh("r1", CREDS);
      expect(t.refresh_token).toBe("r");
      expect(urls(fetchMock)).toEqual([
        OURA_OAUTH_TOKEN_URL,
        OURA_OAUTH_LEGACY_TOKEN_URL,
      ]);
    },
  );

  it("reports the live endpoint's refusal when both refuse", async () => {
    installFetchMock([
      { status: 400, body: { error: "invalid_grant" } },
      { status: 400, body: { error: "invalid_request" } },
    ]);
    await expect(ouraOAuth.refresh("dead", CREDS)).rejects.toMatchObject({
      upstreamError: "invalid_grant",
    });
  });

  it("does not fall back on a server error or a rate limit", async () => {
    for (const status of [429, 503]) {
      const fetchMock = installFetchMock([{ status }, OK]);
      await expect(ouraOAuth.refresh("r1", CREDS)).rejects.toBeInstanceOf(
        OuraApiError,
      );
      expect(urls(fetchMock)).toEqual([OURA_OAUTH_TOKEN_URL]);
      vi.unstubAllGlobals();
    }
  });
});

describe("isAcceptedOuraIssuer", () => {
  it("accepts no issuer and Oura's own servers", () => {
    expect(isAcceptedOuraIssuer(null)).toBe(true);
    expect(
      isAcceptedOuraIssuer(
        "https://moi.ouraring.com/oauth/v2/ext/oauth-anonymous",
      ),
    ).toBe(true);
    expect(isAcceptedOuraIssuer("https://cloud.ouraring.com")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const iss of [
      "https://evil.example/oauth",
      "http://moi.ouraring.com/oauth",
      "https://moi.ouraring.com.evil.example/",
      "not a url",
      "",
    ]) {
      expect(isAcceptedOuraIssuer(iss), iss).toBe(false);
    }
  });
});

describe("fetchReadiness pagination", () => {
  it("walks next_token across pages", async () => {
    installFetchMock([
      {
        status: 200,
        body: {
          data: [{ id: "1", day: "2026-06-09", score: 70 }],
          next_token: "abc",
        },
      },
      {
        status: 200,
        body: {
          data: [{ id: "2", day: "2026-06-10", score: 80 }],
          next_token: null,
        },
      },
    ]);
    const r = await fetchReadiness("tok", {
      startDate: "2026-06-01",
      endDate: "2026-06-10",
    });
    expect(r).toHaveLength(2);
  });

  it("ends on an empty next_token without reading the first page again", async () => {
    const page = {
      status: 200,
      body: {
        data: [{ id: "1", day: "2026-06-09", score: 70 }],
        next_token: "",
      },
    };
    const fetchMock = installFetchMock([page, page]);
    const r = await fetchReadiness("tok", {
      startDate: "2026-06-01",
      endDate: "2026-06-10",
    });
    expect(r).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("mapReadiness", () => {
  it("maps score -> RECOVERY_SCORE", () => {
    const r: OuraReadiness = { id: "1", day: "2026-06-10", score: 84 };
    const mapped = mapReadiness(r);
    expect(mapped.find((m) => m.type === "RECOVERY_SCORE")).toMatchObject({
      value: 84,
      fieldTag: "recovery",
    });
  });
  it("maps temperature_deviation -> BODY_TEMPERATURE_DEVIATION (signed °C)", () => {
    const r: OuraReadiness = {
      id: "1",
      day: "2026-06-10",
      score: 70,
      temperature_deviation: -0.42,
    };
    const mapped = mapReadiness(r);
    const dev = mapped.find((m) => m.type === "BODY_TEMPERATURE_DEVIATION");
    expect(dev).toMatchObject({
      value: -0.42,
      unit: "celsius",
      fieldTag: "temp_deviation",
    });
  });
  it("emits the temperature deviation even when the score is absent", () => {
    const mapped = mapReadiness({
      id: "1",
      day: "2026-06-10",
      score: null,
      temperature_deviation: 0.3,
    });
    expect(mapped).toHaveLength(1);
    expect(mapped[0].type).toBe("BODY_TEMPERATURE_DEVIATION");
  });
  it("skips a record with no score and no temperature", () => {
    expect(mapReadiness({ id: "1", day: "2026-06-10", score: null })).toEqual(
      [],
    );
  });
});

describe("mapSleep", () => {
  it("maps a rejected (`rest`) or deleted period to nothing", () => {
    const base: OuraSleep = {
      id: "rec-r",
      day: "2026-06-10",
      bedtime_start: "2026-06-10T14:00:00.000Z",
      bedtime_end: "2026-06-10T15:00:00.000Z",
      sleep_phase_5_min: "222222222222",
      lowest_heart_rate: 58,
      average_hrv: 40,
    };
    expect(mapSleep({ ...base, type: "rest" })).toEqual([]);
    expect(mapSleep({ ...base, type: "deleted" })).toEqual([]);
    // Periods Oura counts still map, a nap included.
    for (const type of ["long_sleep", "sleep", "late_nap", undefined]) {
      expect(mapSleep({ ...base, type }).length).toBeGreaterThan(0);
    }
  });

  it("falls back to stage totals (no hypnogram) and record-scopes the externalId", () => {
    const s: OuraSleep = {
      id: "rec-9",
      day: "2026-06-10",
      light_sleep_duration: 3600,
      deep_sleep_duration: 1800,
      rem_sleep_duration: 5400,
      awake_time: 600,
      efficiency: 91,
      average_hrv: 48,
      lowest_heart_rate: 49,
      average_breath: 14.5,
    };
    const mapped = mapSleep(s);
    expect(mapped.find((m) => m.sleepStage === "CORE")?.value).toBe(60);
    expect(mapped.find((m) => m.sleepStage === "AWAKE")?.value).toBe(10);
    expect(mapped.find((m) => m.type === "SLEEP_EFFICIENCY")?.value).toBe(91);
    expect(mapped.find((m) => m.type === "HRV_RMSSD")?.value).toBe(48);
    expect(mapped.find((m) => m.type === "RESTING_HEART_RATE")?.value).toBe(49);
    expect(mapped.find((m) => m.type === "RESPIRATORY_RATE")?.value).toBe(14.5);
    // B2 — every sleep row is record-scoped so a nap never overwrites the main.
    expect(mapped.every((m) => m.externalId?.startsWith("sleep:rec-9:"))).toBe(
      true,
    );
  });

  it("emits a real timed timeline from sleep_phase_5_min (reconstructed=false)", () => {
    // 2× deep (1), 3× light (2), 1× rem (3), 1× awake (4) = 7 five-min intervals.
    const s: OuraSleep = {
      id: "rec-T",
      day: "2026-06-10",
      bedtime_start: "2026-06-09T23:00:00.000Z",
      bedtime_end: "2026-06-10T07:00:00.000Z",
      sleep_phase_5_min: "1122234",
    };
    const mapped = mapSleep(s).filter((m) => m.type === "SLEEP_DURATION");
    // Four contiguous runs → four segments, in onset order.
    expect(mapped.map((m) => m.sleepStage)).toEqual([
      "DEEP",
      "CORE",
      "REM",
      "AWAKE",
    ]);
    // Run lengths × 5 min: 2→10, 3→15, 1→5, 1→5.
    expect(mapped.map((m) => m.value)).toEqual([10, 15, 5, 5]);
    // Each segment stamped at its own END instant relative to bedtime_start.
    const onset = new Date("2026-06-09T23:00:00.000Z").getTime();
    expect(mapped[0].measuredAt.getTime()).toBe(onset + 10 * 60_000);
    expect(mapped[1].measuredAt.getTime()).toBe(onset + 25 * 60_000);
    // Distinct, record-scoped externalIds keyed on each run's own START
    // instant (no collapse). NOT a positional run index: a revised hypnogram
    // re-segments the night, so an index shifted every following run onto the
    // wrong row and left phantom tail rows the night-total double-counted.
    const ids = mapped.map((m) => m.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("sleep:rec-T:seg:2026-06-09T23:00:00.000Z");
    expect(ids[1]).toBe("sleep:rec-T:seg:2026-06-09T23:10:00.000Z");
  });

  it("keeps IDENTICAL externalIds for unchanged runs across a revised hypnogram", () => {
    // The same night re-scored: Oura re-classifies the SECOND run's digits,
    // splitting one run into two — every later run's index would have
    // shifted (+1) under the retired run-indexed key, minting fresh ids. The
    // start-keyed ids of the UNCHANGED first and last runs must survive; the
    // re-segmented middle mints new ids and the record-scoped sweep clears
    // what the revision orphaned.
    const base = {
      id: "rec-T",
      day: "2026-06-10",
      bedtime_start: "2026-06-09T23:00:00.000Z",
      bedtime_end: "2026-06-10T07:00:00.000Z",
    };
    const idsOf = (hyp: string) =>
      mapSleep({ ...base, sleep_phase_5_min: hyp })
        .filter((m) => m.type === "SLEEP_DURATION")
        .map((m) => m.externalId);

    const first = idsOf("1122234");
    const revised = idsOf("1121234"); // run "222" split into "2","1","2"

    // First run (digits 0-1) and the tail runs that keep their start offsets
    // are identical across the revision.
    expect(revised[0]).toBe(first[0]);
    expect(revised.at(-1)).toBe(first.at(-1));
    // The re-segmented middle mints ids keyed on the new run starts — all
    // still under the record's `sleep:rec-T:seg:` sweep prefix.
    expect(revised.every((id) => id!.startsWith("sleep:rec-T:seg:"))).toBe(
      true,
    );
  });

  it("ignores an empty / malformed hypnogram and uses stage totals", () => {
    const s: OuraSleep = {
      id: "rec-E",
      day: "2026-06-10",
      bedtime_start: "2026-06-09T23:00:00.000Z",
      sleep_phase_5_min: "",
      deep_sleep_duration: 1800,
    };
    const mapped = mapSleep(s).filter((m) => m.type === "SLEEP_DURATION");
    expect(mapped).toHaveLength(1);
    expect(mapped[0].sleepStage).toBe("DEEP");
    expect(mapped[0].fieldTag).toBe("sleep_deep");
  });
});

describe("mapDailyActivity", () => {
  it("maps steps and active energy, and never the equivalent walking distance", () => {
    const a: OuraDailyActivity = {
      id: "1",
      day: "2026-06-10",
      steps: 9001,
      active_calories: 412,
      equivalent_walking_distance: 6543,
    };
    const mapped = mapDailyActivity(a);
    expect(mapped.find((m) => m.type === "ACTIVITY_STEPS")?.value).toBe(9001);
    expect(mapped.find((m) => m.type === "ACTIVE_ENERGY_BURNED")?.value).toBe(
      412,
    );
    // An activity equivalent, not distance travelled: no distance row at all.
    expect(mapped.map((m) => m.type).sort()).toEqual([
      "ACTIVE_ENERGY_BURNED",
      "ACTIVITY_STEPS",
    ]);
    expect(mapped.some((m) => m.fieldTag === "distance")).toBe(false);
  });
});

describe("mapDailySleep", () => {
  it("maps the Sleep Score -> SLEEP_SCORE", () => {
    const d: OuraDailySleep = { id: "1", day: "2026-06-10", score: 82 };
    const mapped = mapDailySleep(d);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      type: "SLEEP_SCORE",
      value: 82,
      unit: "score",
      fieldTag: "sleep_score",
    });
  });
  it("skips a record with no score", () => {
    expect(mapDailySleep({ id: "1", day: "2026-06-10", score: null })).toEqual(
      [],
    );
  });
});

describe("mapDailySpo2", () => {
  it("maps the average SpO2 -> OXYGEN_SATURATION", () => {
    const s: OuraDailySpo2 = {
      id: "1",
      day: "2026-06-10",
      spo2_percentage: { average: 96.8 },
    };
    const mapped = mapDailySpo2(s);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      type: "OXYGEN_SATURATION",
      value: 96.8,
      unit: "%",
      fieldTag: "spo2",
    });
  });
  it("skips a record with no average", () => {
    expect(
      mapDailySpo2({
        id: "1",
        day: "2026-06-10",
        spo2_percentage: { average: null },
      }),
    ).toEqual([]);
  });
});

describe("fetchVo2Max", () => {
  it("reads the camel-cased vO2_max collection path", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: {
          data: [{ id: "1", day: "2026-06-10", vo2_max: 47.3 }],
          next_token: null,
        },
      },
    ]);
    const r = await fetchVo2Max("tok", {
      startDate: "2026-06-01",
      endDate: "2026-06-10",
    });
    expect(r).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v2/usercollection/vO2_max");
  });
});

describe("mapVo2Max", () => {
  it("maps vo2_max -> VO2_MAX (mL/(kg·min))", () => {
    const v: OuraVo2Max = { id: "1", day: "2026-06-10", vo2_max: 47.3 };
    const mapped = mapVo2Max(v);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      type: "VO2_MAX",
      value: 47.3,
      unit: "mL/(kg·min)",
      fieldTag: "vo2_max",
    });
  });
  it("skips a record with no positive value", () => {
    expect(mapVo2Max({ id: "1", day: "2026-06-10", vo2_max: 0 })).toEqual([]);
    expect(mapVo2Max({ id: "1", day: "2026-06-10", vo2_max: null })).toEqual(
      [],
    );
  });
});

describe("fetchCardiovascularAge", () => {
  it("reads the daily_cardiovascular_age collection path", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: {
          data: [{ id: "1", day: "2026-06-10", vascular_age: 39 }],
          next_token: null,
        },
      },
    ]);
    const r = await fetchCardiovascularAge("tok", {
      startDate: "2026-06-01",
      endDate: "2026-06-10",
    });
    expect(r).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v2/usercollection/daily_cardiovascular_age");
  });
});

describe("mapCardiovascularAge", () => {
  it("maps vascular_age -> VASCULAR_AGE (years)", () => {
    const c: OuraCardiovascularAge = { day: "2026-06-10", vascular_age: 39 };
    const mapped = mapCardiovascularAge(c);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      type: "VASCULAR_AGE",
      value: 39,
      unit: "years",
      fieldTag: "vascular_age",
    });
  });
  it("skips a record with no positive value", () => {
    expect(
      mapCardiovascularAge({ day: "2026-06-10", vascular_age: 0 }),
    ).toEqual([]);
    expect(
      mapCardiovascularAge({ day: "2026-06-10", vascular_age: null }),
    ).toEqual([]);
  });
});

describe("fetchResilience", () => {
  it("reads the daily_resilience collection path", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: {
          data: [{ id: "1", day: "2026-06-10", level: "solid" }],
          next_token: null,
        },
      },
    ]);
    const r = await fetchResilience("tok", {
      startDate: "2026-06-01",
      endDate: "2026-06-10",
    });
    expect(r).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v2/usercollection/daily_resilience");
  });
});

describe("mapResilience", () => {
  it("ordinal-encodes all five levels (limited=1 … exceptional=5)", () => {
    const expected: Array<[string, number]> = [
      ["limited", 1],
      ["adequate", 2],
      ["solid", 3],
      ["strong", 4],
      ["exceptional", 5],
    ];
    for (const [level, ordinal] of expected) {
      const mapped = mapResilience({ day: "2026-06-10", level });
      expect(mapped).toHaveLength(1);
      expect(mapped[0]).toMatchObject({
        type: "RESILIENCE",
        value: ordinal,
        unit: "level",
        fieldTag: "resilience",
      });
    }
  });

  it("RESILIENCE_LEVELS is the source of truth for the encoding", () => {
    expect(RESILIENCE_LEVELS).toEqual({
      limited: 1,
      adequate: 2,
      solid: 3,
      strong: 4,
      exceptional: 5,
    });
  });

  it("is case-insensitive on the level string", () => {
    const mapped = mapResilience({ day: "2026-06-10", level: "STRONG" });
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ type: "RESILIENCE", value: 4 });
  });

  it("skips an unknown / missing level (no row, never coerced to 0)", () => {
    const cases: OuraResilience[] = [
      { day: "2026-06-10", level: "extraordinary" },
      { day: "2026-06-10", level: "" },
      { day: "2026-06-10", level: null },
      { day: "2026-06-10" },
    ];
    for (const c of cases) {
      expect(mapResilience(c)).toEqual([]);
    }
  });

  it("anchors the date-only row at noon UTC so it round-trips the day", () => {
    // Noon, not midnight: a UTC-midnight anchor double-shifts the calendar
    // day for west-of-UTC users when the read path re-buckets via userDayKey.
    const mapped = mapResilience({ day: "2026-06-10", level: "adequate" });
    expect(mapped[0]?.measuredAt.toISOString()).toBe(
      "2026-06-10T12:00:00.000Z",
    );
  });
});

describe("collection refusals", () => {
  const query = { startDate: "2026-06-01", endDate: "2026-06-10" };

  it("reads a 401 that names a scope as a missing permission, not a dead token", async () => {
    installFetchMock([
      {
        status: 401,
        body: { detail: "Token is not authorized access stress scope." },
      },
    ]);
    const err = await fetchResilience("tok", query).catch((e) => e);
    expect(err).toBeInstanceOf(OuraApiError);
    expect(err.httpStatus).toBe(401);
    expect(err.missingScope).toBe("stress");
    expect(err.reason).toBe("scope_missing");
  });

  it("keeps a dead token's 401 a token refusal", async () => {
    installFetchMock([
      {
        status: 401,
        body: {
          detail:
            "The access token provided is expired, revoked, malformed, or invalid for other reasons.",
        },
      },
    ]);
    const err = await fetchReadiness("tok", query).catch((e) => e);
    expect(err.httpStatus).toBe(401);
    expect(err.missingScope).toBeUndefined();
    expect(err.classification).toBe("reauth_required");
  });

  it("classifies a 403 (lapsed membership) as persistent rather than a reconnect", async () => {
    installFetchMock([{ status: 403, body: { detail: "forbidden" } }]);
    const err = await fetchReadiness("tok", query).catch((e) => e);
    expect(err.httpStatus).toBe(403);
    expect(err.classification).toBe("persistent");
  });
});

describe("fetchDailyCyclePhases", () => {
  it("reads the daily_cycle_phases collection path", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: {
          data: [{ id: "1", day: "2026-06-10", phase: "follicular" }],
          next_token: null,
        },
      },
    ]);
    const r = await fetchDailyCyclePhases("tok", {
      startDate: "2026-06-01",
      endDate: "2026-06-10",
    });
    expect(r).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v2/usercollection/daily_cycle_phases");
  });

  it("propagates a 403 (the undocumented / scope-gated case) as an OuraApiError", async () => {
    installFetchMock([{ status: 403, body: { detail: "forbidden" } }]);
    await expect(
      fetchDailyCyclePhases("tok", {
        startDate: "2026-06-01",
        endDate: "2026-06-10",
      }),
    ).rejects.toBeInstanceOf(OuraApiError);
  });
});

describe("derivePeriodDaysFromCyclePhases", () => {
  it("marks a literal 'menstrual' phase day directly", () => {
    const days = derivePeriodDaysFromCyclePhases([
      { day: "2026-06-05", phase: "menstrual" },
      { day: "2026-06-10", phase: "follicular" },
    ]);
    expect(days).toEqual(["2026-06-05"]);
  });

  it("marks the single day a luteal phase transitions into a follicular phase", () => {
    const days = derivePeriodDaysFromCyclePhases([
      { day: "2026-06-08", phase: "luteal" },
      { day: "2026-06-09", phase: "luteal" },
      { day: "2026-06-10", phase: "follicular" },
      { day: "2026-06-11", phase: "follicular" },
    ]);
    expect(days).toEqual(["2026-06-10"]);
  });

  it("does NOT mark a luteal→follicular transition across a gap in the series", () => {
    const days = derivePeriodDaysFromCyclePhases([
      { day: "2026-06-08", phase: "luteal" },
      // 2026-06-09 missing — not calendar-adjacent.
      { day: "2026-06-10", phase: "follicular" },
    ]);
    expect(days).toEqual([]);
  });

  it("is order-independent — sorts records by day before scanning", () => {
    const days = derivePeriodDaysFromCyclePhases([
      { day: "2026-06-10", phase: "follicular" },
      { day: "2026-06-09", phase: "luteal" },
    ]);
    expect(days).toEqual(["2026-06-10"]);
  });

  it("ignores an unrecognised / missing phase string (never guesses)", () => {
    const days = derivePeriodDaysFromCyclePhases([
      { day: "2026-06-08", phase: "luteal" },
      { day: "2026-06-09", phase: "unknown_future_phase" },
      { day: "2026-06-10", phase: "follicular" },
    ]);
    // The unrecognised phase still updates the "previous phase" tracker (to
    // a value that is neither luteal nor follicular), so the 06-09→06-10
    // step is no longer a luteal→follicular transition and nothing fires.
    expect(days).toEqual([]);
  });

  it("returns [] for an empty or all-ovulatory/all-luteal series (no transition, no direct hit)", () => {
    expect(derivePeriodDaysFromCyclePhases([])).toEqual([]);
    expect(
      derivePeriodDaysFromCyclePhases([
        { day: "2026-06-08", phase: "luteal" },
        { day: "2026-06-09", phase: "luteal" },
      ]),
    ).toEqual([]);
  });

  it("skips records with a missing/empty day string", () => {
    const days = derivePeriodDaysFromCyclePhases([
      { day: "", phase: "menstrual" },
      { day: "2026-06-10", phase: "menstrual" },
    ] as never);
    expect(days).toEqual(["2026-06-10"]);
  });
});

describe("date-only records in the user's zone", () => {
  it.each([
    ["Pacific/Tongatapu", "2026-05-09T23:00:00.000Z"],
    ["Pacific/Auckland", "2026-05-10T00:00:00.000Z"],
    ["America/New_York", "2026-05-10T16:00:00.000Z"],
    ["Europe/Berlin", "2026-05-10T10:00:00.000Z"],
  ])("anchors a date-only record at local noon in %s", (tz, iso) => {
    const [spo2] = mapDailySpo2(
      { day: "2026-05-10", spo2_percentage: { average: 97 } } as never,
      tz,
    );
    expect(spo2!.measuredAt.toISOString()).toBe(iso);
    const [resilience] = mapResilience(
      { day: "2026-05-10", level: "solid" } as never,
      tz,
    );
    expect(resilience!.measuredAt.toISOString()).toBe(iso);
  });
});
