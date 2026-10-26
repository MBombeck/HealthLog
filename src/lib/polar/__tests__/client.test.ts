import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { annotateMock } = vi.hoisted(() => ({ annotateMock: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({
  annotate: annotateMock,
  getEvent: () => null,
}));

import {
  fetchActivities,
  fetchCardioLoads,
  fetchNightlyRecharges,
  fetchSleeps,
  fetchSpo2,
  registerUser,
} from "../client";
import {
  mapActivity,
  mapCardioLoad,
  mapNightlyRecharge,
  mapSleep,
  mapSpo2,
} from "@/lib/polar/map";
import {
  type PolarActivity,
  type PolarCardioLoad,
  type PolarNightlyRecharge,
  type PolarSleep,
  type PolarSpo2,
} from "@/lib/polar/wire-types";
import { POLAR_OAUTH_SCOPE, getPolarCredentials } from "@/lib/polar/oauth";
import { PolarApiError } from "../response-classifier";
import { polarOAuth } from "../oauth";

const CREDS = { clientId: "cid", clientSecret: "csecret" };

function installFetchMock(pages: Array<{ status: number; body?: unknown }>) {
  let i = 0;
  const fetchMock = vi.fn(async (...args: [string, RequestInit?]) => {
    void args;
    const page = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    return {
      status: page.status,
      json: async () => page.body ?? null,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  annotateMock.mockClear();
  process.env.POLAR_CLIENT_ID = "env-cid";
  process.env.POLAR_CLIENT_SECRET = "env-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
  delete process.env.POLAR_REDIRECT_URI;
});

function driftAnnotations() {
  return annotateMock.mock.calls
    .map((c) => c[0])
    .filter((f) => f?.action?.name === "polar.envelope.drift");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getPolarCredentials", () => {
  it("reads from env", () => {
    expect(getPolarCredentials()).toEqual({
      clientId: "env-cid",
      clientSecret: "env-secret",
    });
  });
  it("returns null when unconfigured", () => {
    delete process.env.POLAR_CLIENT_ID;
    expect(getPolarCredentials()).toBeNull();
  });
});

describe("getAuthorizationUrl", () => {
  it("builds the Polar authorize URL with scope + state", () => {
    const url = polarOAuth.authorizationUrl("signed-state", CREDS);
    expect(url).toContain("flow.polar.com/oauth2/authorization");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=accesslink.read_all");
    expect(url).toContain("state=signed-state");
    expect(url).toContain("client_id=cid");
  });
});

describe("getPolarRedirectUri", () => {
  it("derives from app URL when override absent", () => {
    expect(polarOAuth.redirectUri()).toBe(
      "https://app.example/api/polar/callback",
    );
  });
  it("honours the explicit override", () => {
    process.env.POLAR_REDIRECT_URI = "https://custom/cb";
    expect(polarOAuth.redirectUri()).toBe("https://custom/cb");
  });
});

describe("exchangeCode", () => {
  it("posts Basic-auth + returns the token and x_user_id", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: { access_token: "tok", token_type: "bearer", x_user_id: 42 },
      },
    ]);
    const tok = await polarOAuth.exchange("code123", CREDS);
    expect(tok.access_token).toBe("tok");
    expect(tok.x_user_id).toBe(42);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://polarremote.com/v2/oauth2/token",
    );
    expect(fetchMock.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("cid:csecret").toString("base64")}`,
    );
    expect(init!.body).toContain("grant_type=authorization_code");
  });

  it("throws a classified PolarApiError on a 401", async () => {
    installFetchMock([{ status: 401, body: { error: "invalid_grant" } }]);
    await expect(polarOAuth.exchange("bad", CREDS)).rejects.toBeInstanceOf(
      PolarApiError,
    );
  });

  // A 2xx carrying an empty / non-JSON body used to be cast straight to the
  // token type, so callers dereferenced null and got an unclassified
  // TypeError. It must surface as a classified transient integration error.
  it("classifies a 2xx with an empty body instead of casting null", async () => {
    installFetchMock([{ status: 200, body: null }]);
    await expect(polarOAuth.exchange("code", CREDS)).rejects.toMatchObject({
      classification: "transient",
      reason: "empty_token_body",
    });
  });
});

describe("registerUser", () => {
  it("treats a 409 (already registered) as success", async () => {
    installFetchMock([{ status: 409, body: {} }]);
    await expect(registerUser("tok", "42")).resolves.toBeUndefined();
  });
  it("posts to the documented registration path", async () => {
    const fetchMock = installFetchMock([{ status: 200, body: {} }]);
    await expect(registerUser("tok", "42")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.polaraccesslink.com/v3/users",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("throws on a 500", async () => {
    installFetchMock([{ status: 500 }]);
    await expect(registerUser("tok", "42")).rejects.toBeInstanceOf(
      PolarApiError,
    );
  });
});

describe("Polar AccessLink request paths", () => {
  it.each([
    {
      resource: "nightly recharge",
      request: () => fetchNightlyRecharges("tok"),
      url: "https://www.polaraccesslink.com/v3/users/nightly-recharge",
    },
    {
      resource: "sleep",
      request: () => fetchSleeps("tok"),
      url: "https://www.polaraccesslink.com/v3/users/sleep",
    },
    {
      resource: "daily activity",
      request: () => fetchActivities("tok"),
      url: "https://www.polaraccesslink.com/v3/users/activities",
    },
    {
      resource: "cardio load",
      request: () => fetchCardioLoads("tok"),
      url: "https://www.polaraccesslink.com/v3/users/cardio-load",
    },
    {
      resource: "SpO2",
      request: () => fetchSpo2("tok"),
      url: "https://www.polaraccesslink.com/v3/users/biosensing/spo2",
    },
  ])("uses the documented GET path for $resource", async ({ request, url }) => {
    const fetchMock = installFetchMock([{ status: 204 }]);

    await request();

    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("fetchNightlyRecharges", () => {
  it("returns [] on a 204 No Content", async () => {
    installFetchMock([{ status: 204 }]);
    expect(await fetchNightlyRecharges("tok")).toEqual([]);
  });
  it("unwraps the recharges array", async () => {
    installFetchMock([
      { status: 200, body: { recharges: [{ date: "2026-06-10" }] } },
    ]);
    const r = await fetchNightlyRecharges("tok");
    expect(r).toHaveLength(1);
    expect(r[0]!.date).toBe("2026-06-10");
  });
});

describe("fetchCollection — envelope drift logging", () => {
  it("logs a drift breadcrumb (verb + top-level keys) and degrades to [] on an unexpected wrapped shape", async () => {
    installFetchMock([
      { status: 200, body: { unexpected: [{ date: "2026-06-10" }] } },
    ]);
    expect(await fetchNightlyRecharges("tok")).toEqual([]);
    const drift = driftAnnotations();
    expect(drift).toHaveLength(1);
    expect(drift[0].action.details).toMatchObject({
      verb: "fetchNightlyRecharges",
      httpStatus: 200,
      keys: ["unexpected"],
    });
  });

  it("does NOT drift on the correctly wrapped envelope", async () => {
    installFetchMock([
      { status: 200, body: { recharges: [{ date: "2026-06-10" }] } },
    ]);
    expect(await fetchNightlyRecharges("tok")).toHaveLength(1);
    expect(driftAnnotations()).toHaveLength(0);
  });

  it("does NOT drift on a bare array for a bare-array endpoint", async () => {
    installFetchMock([
      { status: 200, body: [{ date: "2026-06-10", cardio_load: 12 }] },
    ]);
    expect(await fetchCardioLoads("tok")).toHaveLength(1);
    expect(driftAnnotations()).toHaveLength(0);
  });

  it("drifts when a bare-array endpoint returns a non-array object", async () => {
    installFetchMock([{ status: 200, body: { rows: [{ cardio_load: 1 }] } }]);
    expect(await fetchCardioLoads("tok")).toEqual([]);
    const drift = driftAnnotations();
    expect(drift).toHaveLength(1);
    expect(drift[0].action.details).toMatchObject({
      verb: "fetchCardioLoads",
      keys: ["rows"],
    });
  });

  it("does NOT drift on a 204 empty window", async () => {
    installFetchMock([{ status: 204 }]);
    expect(await fetchSleeps("tok")).toEqual([]);
    expect(driftAnnotations()).toHaveLength(0);
  });
});

describe("mapNightlyRecharge", () => {
  it("maps the recovery band to a 0-100 RECOVERY_SCORE", () => {
    const rec: PolarNightlyRecharge = {
      date: "2026-06-10",
      nightly_recharge_status: 6,
      heart_rate_variability_avg: 55,
      heart_rate_avg: 52.4,
      breathing_rate_avg: 14.2,
    };
    const mapped = mapNightlyRecharge(rec);
    const recovery = mapped.find((m) => m.type === "RECOVERY_SCORE");
    expect(recovery?.value).toBe(100);
    expect(mapped.find((m) => m.type === "HRV_RMSSD")?.value).toBe(55);
    expect(mapped.find((m) => m.type === "RESTING_HEART_RATE")?.value).toBe(52);
    expect(mapped.find((m) => m.type === "RESPIRATORY_RATE")?.value).toBe(14.2);
  });

  it("maps ans_charge to ANS_CHARGE (through-as-is, negative allowed)", () => {
    const mapped = mapNightlyRecharge({
      date: "2026-06-10",
      ans_charge: -3.42,
    });
    const ans = mapped.find((m) => m.type === "ANS_CHARGE");
    expect(ans?.value).toBe(-3.42);
    expect(ans?.unit).toBe("score");
    expect(ans?.fieldTag).toBe("ans_charge");
  });

  it("keeps a zero ans_charge (baseline is a valid reading)", () => {
    const mapped = mapNightlyRecharge({ date: "2026-06-10", ans_charge: 0 });
    expect(mapped.find((m) => m.type === "ANS_CHARGE")?.value).toBe(0);
  });

  it("omits ANS_CHARGE when ans_charge is absent", () => {
    const mapped = mapNightlyRecharge({
      date: "2026-06-10",
      nightly_recharge_status: 3,
    });
    expect(mapped.find((m) => m.type === "ANS_CHARGE")).toBeUndefined();
  });

  it("rescales status 1 -> 0", () => {
    const mapped = mapNightlyRecharge({
      date: "2026-06-10",
      nightly_recharge_status: 1,
    });
    expect(mapped.find((m) => m.type === "RECOVERY_SCORE")?.value).toBe(0);
  });

  it("skips a bad date", () => {
    expect(mapNightlyRecharge({ date: "not-a-date" })).toEqual([]);
  });
});

describe("mapSleep", () => {
  it("maps per-stage durations s->min and the sleep score", () => {
    const s: PolarSleep = {
      date: "2026-06-10",
      sleep_start_time: "2026-06-09T23:00:00+02:00",
      sleep_end_time: "2026-06-10T07:00:00+02:00",
      light_sleep: 3600,
      deep_sleep: 1800,
      rem_sleep: 5400,
      sleep_score: 82,
    };
    const mapped = mapSleep(s);
    const core = mapped.find((m) => m.sleepStage === "CORE");
    expect(core?.value).toBe(60);
    expect(mapped.find((m) => m.sleepStage === "DEEP")?.value).toBe(30);
    expect(mapped.find((m) => m.sleepStage === "REM")?.value).toBe(90);
    expect(mapped.find((m) => m.type === "SLEEP_PERFORMANCE")?.value).toBe(82);
  });

  it("lays a reconstructed END-instant timeline from the sleep window", () => {
    const start = "2026-06-09T23:00:00+02:00"; // 21:00 UTC
    const s: PolarSleep = {
      date: "2026-06-10",
      sleep_start_time: start,
      sleep_end_time: "2026-06-10T07:00:00+02:00", // 05:00 UTC
      light_sleep: 3600, // 60 min
      deep_sleep: 1800, // 30 min
      rem_sleep: 5400, // 90 min
      sleep_score: 82,
    };
    const mapped = mapSleep(s);
    const onset = Date.parse(start);
    const core = mapped.find((m) => m.sleepStage === "CORE")!;
    const deep = mapped.find((m) => m.sleepStage === "DEEP")!;
    const rem = mapped.find((m) => m.sleepStage === "REM")!;

    // Each segment ends at its own instant, laid contiguously from onset:
    // CORE ends at +60m, DEEP at +90m, REM at +180m.
    expect(core.measuredAt.getTime()).toBe(onset + 60 * 60_000);
    expect(deep.measuredAt.getTime()).toBe(onset + 90 * 60_000);
    expect(rem.measuredAt.getTime()).toBe(onset + 180 * 60_000);

    // Distinct instants → an ordered hypnogram (the F1 fix), not three
    // coincident midnight-UTC points.
    const instants = new Set(
      [core, deep, rem].map((m) => m.measuredAt.getTime()),
    );
    expect(instants.size).toBe(3);

    // Reconstructed flag + stage-tagged externalId keep the segment rows
    // distinct. No positional index: an index renumbered on a re-score when a
    // stage's duration flipped 0↔positive, minting fresh ids that inserted a
    // duplicate night.
    expect(core.reconstructed).toBe(true);
    expect(core.externalId).toBe("sleep:2026-06-10:seg:sleep_core");
    expect(rem.externalId).toBe("sleep:2026-06-10:seg:sleep_rem");

    // IN_BED envelope + score stamp at the sleep END instant.
    const endMs = Date.parse("2026-06-10T07:00:00+02:00");
    const inBed = mapped.find((m) => m.sleepStage === "IN_BED")!;
    expect(inBed.measuredAt.getTime()).toBe(endMs);
    expect(inBed.value).toBe(480); // 8 h
    expect(
      mapped.find((m) => m.type === "SLEEP_PERFORMANCE")!.measuredAt.getTime(),
    ).toBe(endMs);
  });

  it("emits an AWAKE segment from total_interruption_duration", () => {
    const start = "2026-06-09T23:00:00+02:00"; // 21:00 UTC
    const s: PolarSleep = {
      date: "2026-06-10",
      sleep_start_time: start,
      sleep_end_time: "2026-06-10T07:00:00+02:00",
      total_interruption_duration: 900, // 15 min awake
      light_sleep: 3600, // 60 min
      deep_sleep: 1800, // 30 min
      rem_sleep: 5400, // 90 min
      sleep_score: 82,
    };
    const mapped = mapSleep(s);
    const onset = Date.parse(start);

    // AWAKE is laid first (leading settling-in block), so the asleep stages
    // partition the rest of the window and the night reader can surface real
    // awake time + efficiency rather than a fully consolidated night.
    const awake = mapped.find((m) => m.sleepStage === "AWAKE")!;
    expect(awake).toBeDefined();
    expect(awake.value).toBe(15);
    expect(awake.reconstructed).toBe(true);
    expect(awake.externalId).toBe("sleep:2026-06-10:seg:sleep_awake");
    // AWAKE ends at +15m; CORE then starts there.
    expect(awake.measuredAt.getTime()).toBe(onset + 15 * 60_000);

    const core = mapped.find((m) => m.sleepStage === "CORE")!;
    expect(core.externalId).toBe("sleep:2026-06-10:seg:sleep_core");
    expect(core.measuredAt.getTime()).toBe(onset + (15 + 60) * 60_000);
  });

  it("keeps IDENTICAL externalIds across a re-score that adds an interruption block", () => {
    // The same night scored twice: first with no interruption time, then with
    // a positive AWAKE block. Under the retired positional index the AWAKE
    // 0↔positive flip renumbered CORE/DEEP/REM (0,1,2 → 1,2,3), minting
    // fresh externalIds the upsert then INSERTED next to the old rows — the
    // night double-counted. The stage-tagged ids must be identical.
    const night = {
      date: "2026-06-10",
      sleep_start_time: "2026-06-09T23:00:00+02:00",
      sleep_end_time: "2026-06-10T07:00:00+02:00",
      light_sleep: 3600,
      deep_sleep: 1800,
      rem_sleep: 5400,
    };
    const idsByStage = (rows: ReturnType<typeof mapSleep>) =>
      new Map(
        rows
          .filter((m) => m.reconstructed)
          .map((m) => [m.sleepStage, m.externalId]),
      );
    const first = idsByStage(mapSleep(night));
    const rescored = idsByStage(
      mapSleep({ ...night, total_interruption_duration: 900 }),
    );
    for (const stage of ["CORE", "DEEP", "REM"] as const) {
      expect(rescored.get(stage)).toBe(first.get(stage));
    }
    expect(rescored.get("AWAKE")).toBe("sleep:2026-06-10:seg:sleep_awake");
  });

  it("omits AWAKE when no interruption time is reported", () => {
    const mapped = mapSleep({
      date: "2026-06-10",
      sleep_start_time: "2026-06-09T23:00:00+02:00",
      sleep_end_time: "2026-06-10T07:00:00+02:00",
      light_sleep: 3600,
      deep_sleep: 1800,
      rem_sleep: 5400,
    });
    expect(mapped.find((m) => m.sleepStage === "AWAKE")).toBeUndefined();
    // CORE keeps the same stage-tagged id whether AWAKE is present or not.
    expect(mapped.find((m) => m.sleepStage === "CORE")!.externalId).toBe(
      "sleep:2026-06-10:seg:sleep_core",
    );
  });

  it("falls back to a noon-UTC anchor when the window is missing", () => {
    const mapped = mapSleep({
      date: "2026-06-10",
      light_sleep: 3600,
      sleep_score: 80,
    });
    const core = mapped.find((m) => m.sleepStage === "CORE")!;
    // Noon, not midnight: keeps the date-only row on the same calendar day for
    // every zone when the read path re-buckets via userDayKey.
    expect(core.measuredAt.toISOString()).toBe("2026-06-10T12:00:00.000Z");
    expect(core.reconstructed).toBeUndefined();
    // No IN_BED envelope without a window.
    expect(mapped.find((m) => m.sleepStage === "IN_BED")).toBeUndefined();
  });
});

describe("mapActivity — distance", () => {
  it("maps distance_from_steps to WALKING_RUNNING_DISTANCE in metres", () => {
    const a: PolarActivity = {
      start_time: "2026-06-10T00:00:00",
      steps: 8000,
      distance_from_steps: 4590.53,
    };
    const dist = mapActivity(a).find(
      (m) => m.type === "WALKING_RUNNING_DISTANCE",
    );
    expect(dist?.value).toBe(4590.53);
    expect(dist?.unit).toBe("meters");
  });
});

describe("mapCardioLoad", () => {
  it("maps cardio_load to CARDIO_LOAD", () => {
    const c: PolarCardioLoad = { date: "2026-06-10", cardio_load: 123.45 };
    const mapped = mapCardioLoad(c);
    expect(mapped[0]?.type).toBe("CARDIO_LOAD");
    expect(mapped[0]?.value).toBe(123.45);
    expect(mapped[0]?.unit).toBe("score");
  });
  it("keeps a zero cardio_load and skips a missing one", () => {
    expect(
      mapCardioLoad({ date: "2026-06-10", cardio_load: 0 })[0]?.value,
    ).toBe(0);
    expect(mapCardioLoad({ date: "2026-06-10" })).toEqual([]);
  });
});

describe("mapSpo2", () => {
  it("maps the documented SpO2 fields to an exact-timestamp reading", () => {
    const r: PolarSpo2 = {
      test_time: 1_781_059_600,
      blood_oxygen_percent: 96,
      source_device_id: "device-1",
    };
    const mapped = mapSpo2(r);
    expect(mapped[0]?.type).toBe("OXYGEN_SATURATION");
    expect(mapped[0]?.value).toBe(96);
    expect(mapped[0]?.unit).toBe("%");
    expect(mapped[0]?.measuredAt.toISOString()).toBe(
      "2026-06-10T02:46:40.000Z",
    );
    expect(mapped[0]?.externalId).toBe("spo2:1781059600:device-1");
  });
  it("rejects out-of-range readings", () => {
    expect(
      mapSpo2({ test_time: 1_781_059_600, blood_oxygen_percent: 0 }),
    ).toEqual([]);
    expect(
      mapSpo2({ test_time: 1_781_059_600, blood_oxygen_percent: 120 }),
    ).toEqual([]);
  });
});

describe("fetchCardioLoads", () => {
  it("returns the documented top-level cardio-load array", async () => {
    installFetchMock([
      { status: 200, body: [{ date: "2026-06-10", cardio_load: 123.45 }] },
    ]);
    const r = await fetchCardioLoads("tok");
    expect(r).toHaveLength(1);
  });
});

describe("fetchSpo2", () => {
  it("returns the documented top-level SpO2 array", async () => {
    installFetchMock([
      {
        status: 200,
        body: [{ test_time: 1_781_059_600, blood_oxygen_percent: 96 }],
      },
    ]);
    const r = await fetchSpo2("tok");
    expect(r).toHaveLength(1);
  });
});

describe("fetchActivities", () => {
  it("returns the documented top-level activity array", async () => {
    installFetchMock([
      {
        status: 200,
        body: [
          {
            start_time: "2026-06-10T00:00:00",
            active_calories: 540.6,
            steps: 8123,
          },
        ],
      },
    ]);
    const r = await fetchActivities("tok");
    expect(r).toHaveLength(1);
  });
});

describe("mapActivity", () => {
  it("maps steps and active energy to canonical MeasurementType enum values", () => {
    const a: PolarActivity = {
      start_time: "2026-06-10T00:00:00",
      steps: 8123,
      active_calories: 540.6,
      calories: 2400,
    };
    const mapped = mapActivity(a);
    expect(mapped.find((m) => m.type === "ACTIVITY_STEPS")?.value).toBe(8123);
    // ACTIVE portion only — NOT the total `calories` (2400, incl. BMR).
    expect(mapped.find((m) => m.type === "ACTIVE_ENERGY_BURNED")?.value).toBe(
      540.6,
    );
  });
  it("ignores an activity when Polar omits its optional start time", () => {
    expect(mapActivity({})).toEqual([]);
  });
});

describe("POLAR_OAUTH_SCOPE", () => {
  it("is the read-all scope", () => {
    expect(POLAR_OAUTH_SCOPE).toBe("accesslink.read_all");
  });
});

describe("date-keyed rows in the user's zone", () => {
  it.each([
    ["Pacific/Tongatapu", "2026-05-09T23:00:00.000Z"],
    ["Pacific/Auckland", "2026-05-10T00:00:00.000Z"],
    ["America/New_York", "2026-05-10T16:00:00.000Z"],
    ["Europe/Berlin", "2026-05-10T10:00:00.000Z"],
  ])(
    "anchors a day's activity at local noon in %s and names the day",
    (tz, iso) => {
      const rows = mapActivity(
        { start_time: "2026-05-10T00:00:00", steps: 9000 } as never,
        tz,
      );
      expect(rows[0]!.measuredAt.toISOString()).toBe(iso);
      expect(rows[0]!.day).toBe("2026-05-10");
      const [load] = mapCardioLoad(
        { date: "2026-05-10", cardio_load: 12 } as never,
        tz,
      );
      expect(load!.measuredAt.toISOString()).toBe(iso);
      expect(load!.day).toBe("2026-05-10");
    },
  );
});
