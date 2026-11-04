/**
 * Integration suite for the v1.15.0 cycle-tracking routes against a real
 * Postgres in a testcontainer. Asserts the iOS-facing contract end-to-end:
 *
 *   - the feature gate (`cycle.disabled` 403) keys on gender + the
 *     `cycleTrackingEnabled` toggle, even with a valid session
 *   - single day-log capture upserts (201 insert → 200 update), encrypts
 *     the note, and reads it back decrypted
 *   - the bulk drain returns per-entry inserted / updated / duplicate
 *   - the period shortcut opens a cycle + boundary day-log
 *   - the calendar read runs the engine + goal-gates the fertile window
 *   - the cycle-prefs PATCH flips the gate for a non-FEMALE account
 *   - `/api/sync/changes` carries the cycleDays + cycles domains incl.
 *     tombstones after a soft-delete
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-cycle-routes-integration-32-bytes-min-1234567890";
// Crypto-at-rest needs a key for the note encrypt/decrypt round-trip.
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const FEMALE_USER_ID = "user-cycle-female";
const MALE_USER_ID = "user-cycle-male";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

async function loginAs(userId: string): Promise<void> {
  cookieJar.clear();
  headerJar.clear();
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: FEMALE_USER_ID,
      username: "cycle-female",
      email: "cycle-female@example.test",
      gender: "FEMALE",
      // The suite runs under TZ=UTC and computes its relative day keys with
      // local Date arithmetic, i.e. in UTC. The route resolves "today" in the
      // USER's zone and falls back to Europe/Berlin when none is set - one
      // hour past 22:00 UTC the two clocks disagree about the date and every
      // day-of-cycle assertion is off by one. Pinning the fixture zone to UTC
      // makes the test's clock and the route's clock the same clock at any
      // hour of the day.
      timezone: "UTC",
    },
  });
  await prisma.user.create({
    data: {
      id: MALE_USER_ID,
      username: "cycle-male",
      email: "cycle-male@example.test",
      gender: "MALE",
      timezone: "UTC",
    },
  });
});

function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
  opts: { idempotencyKey?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("cycle routes — feature gate", () => {
  it("403s a MALE account on every cycle route", async () => {
    await loginAs(MALE_USER_ID);
    const { POST } = await import("@/app/api/cycle/day-logs/route");
    const res = await POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: "2026-03-01",
        flow: "MEDIUM",
        loggedAt: "2026-03-01T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.meta?.errorCode).toBe("cycle.disabled");
  });

  it("admits a FEMALE account by gender derivation", async () => {
    await loginAs(FEMALE_USER_ID);
    const { POST } = await import("@/app/api/cycle/day-logs/route");
    const res = await POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: "2026-03-01",
        flow: "MEDIUM",
        loggedAt: "2026-03-01T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe("cycle day-logs — single capture", () => {
  it("upserts (201 insert → 200 update) and round-trips the encrypted note", async () => {
    await loginAs(FEMALE_USER_ID);
    const { POST } = await import("@/app/api/cycle/day-logs/route");

    const insert = await POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: "2026-03-02",
        flow: "LIGHT",
        note: "tender, mild cramps",
        loggedAt: "2026-03-02T08:00:00.000Z",
      }),
    );
    expect(insert.status).toBe(201);
    const insertJson = await insert.json();
    expect(insertJson.data.flow).toBe("LIGHT");
    expect(insertJson.data.note).toBe("tender, mild cramps");

    // The note column is ciphertext, not plaintext.
    const row = await getPrismaClient().cycleDayLog.findFirstOrThrow({
      where: { userId: FEMALE_USER_ID, date: "2026-03-02" },
    });
    expect(row.notesEncrypted).not.toBeNull();
    expect(row.notesEncrypted).not.toContain("cramps");

    const update = await POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: "2026-03-02",
        flow: "HEAVY",
        loggedAt: "2026-03-02T09:00:00.000Z",
      }),
    );
    expect(update.status).toBe(200);
    const updateJson = await update.json();
    expect(updateJson.data.flow).toBe("HEAVY");
    expect(updateJson.data.id).toBe(insertJson.data.id);
  });
});

describe("cycle day-logs — single read (GET)", () => {
  it("returns the full DTO for a logged day and null for an empty one", async () => {
    await loginAs(FEMALE_USER_ID);
    const route = await import("@/app/api/cycle/day-logs/route");

    await route.POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: "2026-04-01",
        flow: "MEDIUM",
        loggedAt: "2026-04-01T08:00:00.000Z",
      }),
    );

    const hit = await route.GET(
      jsonRequest("/api/cycle/day-logs?date=2026-04-01", "GET"),
    );
    expect(hit.status).toBe(200);
    const hitJson = await hit.json();
    expect(hitJson.data).not.toBeNull();
    expect(hitJson.data.flow).toBe("MEDIUM");
    expect(typeof hitJson.data.id).toBe("string");

    const miss = await route.GET(
      jsonRequest("/api/cycle/day-logs?date=2026-04-09", "GET"),
    );
    expect(miss.status).toBe(200);
    expect((await miss.json()).data).toBeNull();
  });

  it("422s a malformed date query", async () => {
    await loginAs(FEMALE_USER_ID);
    const { GET } = await import("@/app/api/cycle/day-logs/route");
    const res = await GET(jsonRequest("/api/cycle/day-logs?date=nope", "GET"));
    expect(res.status).toBe(422);
  });

  it("round-trips the cervix observation signs through POST → GET", async () => {
    await loginAs(FEMALE_USER_ID);
    const route = await import("@/app/api/cycle/day-logs/route");

    await route.POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: "2026-05-02",
        cervixPosition: "HIGH",
        cervixFirmness: "SOFT",
        cervixOpening: "OPEN",
        loggedAt: "2026-05-02T08:00:00.000Z",
      }),
    );

    const hit = await route.GET(
      jsonRequest("/api/cycle/day-logs?date=2026-05-02", "GET"),
    );
    expect(hit.status).toBe(200);
    const { data } = await hit.json();
    expect(data.cervixPosition).toBe("HIGH");
    expect(data.cervixFirmness).toBe("SOFT");
    expect(data.cervixOpening).toBe("OPEN");
  });
});

describe("cycle day-logs — symptom severity", () => {
  it("persists a 1-4 severity per link and reads it back in the DTO", async () => {
    await loginAs(FEMALE_USER_ID);
    // Ensure a catalog category + symptom exist so the link resolves
    // (idempotent — the seed migration may already provide them).
    const cat = await getPrismaClient().cycleSymptomCategory.upsert({
      where: { key: "physical" },
      create: { key: "physical", labelKey: "cycle.symptomCategory.physical" },
      update: {},
    });
    await getPrismaClient().cycleSymptom.upsert({
      where: { key: "cramps" },
      create: {
        key: "cramps",
        categoryId: cat.id,
        labelKey: "cycle.symptom.cramps",
        isActive: true,
      },
      update: { isActive: true },
    });
    const route = await import("@/app/api/cycle/day-logs/route");

    const insert = await route.POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: "2026-04-15",
        symptoms: [{ key: "cramps", severity: 3 }],
        loggedAt: "2026-04-15T08:00:00.000Z",
      }),
    );
    expect(insert.status).toBe(201);
    const insertJson = await insert.json();
    expect(insertJson.data.symptoms).toEqual([{ key: "cramps", severity: 3 }]);

    const link = await getPrismaClient().cycleSymptomLink.findFirstOrThrow({
      where: { dayLog: { date: "2026-04-15" } },
    });
    expect(link.severity).toBe(3);

    const read = await route.GET(
      jsonRequest("/api/cycle/day-logs?date=2026-04-15", "GET"),
    );
    expect((await read.json()).data.symptoms).toEqual([
      { key: "cramps", severity: 3 },
    ]);
  });
});

describe("cycle day-logs — bulk drain", () => {
  it("returns per-entry inserted / updated / duplicate", async () => {
    await loginAs(FEMALE_USER_ID);
    const { POST } = await import("@/app/api/cycle/day-logs/bulk/route");

    const first = await POST(
      jsonRequest("/api/cycle/day-logs/bulk", "POST", {
        entries: [
          {
            date: "2026-03-05",
            flow: "MEDIUM",
            source: "APPLE_HEALTH",
            externalId: "hk-aaa",
            loggedAt: "2026-03-05T08:00:00.000Z",
          },
        ],
      }),
    );
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.data.inserted).toBe(1);
    expect(firstJson.data.entries[0].status).toBe("inserted");

    // Re-post unchanged → duplicate; re-post changed → updated.
    const second = await POST(
      jsonRequest("/api/cycle/day-logs/bulk", "POST", {
        entries: [
          {
            date: "2026-03-05",
            flow: "MEDIUM",
            source: "APPLE_HEALTH",
            externalId: "hk-aaa",
            loggedAt: "2026-03-05T08:00:00.000Z",
          },
          {
            date: "2026-03-05",
            flow: "HEAVY",
            source: "APPLE_HEALTH",
            externalId: "hk-aaa",
            loggedAt: "2026-03-05T08:00:00.000Z",
          },
        ],
      }),
    );
    const secondJson = await second.json();
    expect(secondJson.data.entries[0].status).toBe("duplicate");
    expect(secondJson.data.entries[1].status).toBe("updated");
  });
});

describe("cycle period shortcut", () => {
  it("opens a cycle + writes the boundary day-log", async () => {
    await loginAs(FEMALE_USER_ID);
    const { POST } = await import("@/app/api/cycle/period/route");
    const res = await POST(
      jsonRequest("/api/cycle/period", "POST", {
        action: "start",
        date: "2026-03-10",
        loggedAt: "2026-03-10T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.cycle.startDate).toBe("2026-03-10");
    expect(json.data.dayLog.flow).toBe("MEDIUM");
  });

  it("closes the prior cycle atomically when a new start is inserted", async () => {
    await loginAs(FEMALE_USER_ID);
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/cycle/period/route");

    await POST(
      jsonRequest("/api/cycle/period", "POST", {
        action: "start",
        date: "2026-04-01",
        loggedAt: "2026-04-01T08:00:00.000Z",
      }),
    );
    await POST(
      jsonRequest("/api/cycle/period", "POST", {
        action: "start",
        date: "2026-04-29",
        loggedAt: "2026-04-29T08:00:00.000Z",
      }),
    );

    const prior = await prisma.menstrualCycle.findFirstOrThrow({
      where: { userId: FEMALE_USER_ID, startDate: "2026-04-01" },
    });
    // Close-prior + open-new ran as one unit: the prior cycle is stamped.
    expect(prior.endDate).toBe("2026-04-28");
    expect(prior.lengthDays).toBe(28);
  });

  it("replays the same idempotency key without a second mutation", async () => {
    await loginAs(FEMALE_USER_ID);
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/cycle/period/route");
    const key = `period-${Date.now()}`;

    const first = await POST(
      jsonRequest(
        "/api/cycle/period",
        "POST",
        {
          action: "start",
          date: "2026-05-10",
          loggedAt: "2026-05-10T08:00:00.000Z",
        },
        { idempotencyKey: key },
      ),
    );
    expect(first.status).toBe(200);

    const replay = await POST(
      jsonRequest(
        "/api/cycle/period",
        "POST",
        {
          action: "start",
          date: "2026-05-10",
          loggedAt: "2026-05-10T08:00:00.000Z",
        },
        { idempotencyKey: key },
      ),
    );
    expect(replay.status).toBe(200);

    const cycles = await prisma.menstrualCycle.count({
      where: {
        userId: FEMALE_USER_ID,
        startDate: "2026-05-10",
        deletedAt: null,
      },
    });
    expect(cycles).toBe(1);
  });

  it("never downgrades a richer same-day flow on the boundary write", async () => {
    await loginAs(FEMALE_USER_ID);
    const prisma = getPrismaClient();
    const dayLogs = await import("@/app/api/cycle/day-logs/route");
    const period = await import("@/app/api/cycle/period/route");

    // A manual HEAVY entry exists for the day…
    await dayLogs.POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: "2026-06-01",
        flow: "HEAVY",
        loggedAt: "2026-06-01T07:00:00.000Z",
      }),
    );
    // …a one-tap "start" (boundary flow MEDIUM) must not downgrade it.
    await period.POST(
      jsonRequest("/api/cycle/period", "POST", {
        action: "start",
        date: "2026-06-01",
        loggedAt: "2026-06-01T08:00:00.000Z",
      }),
    );

    const row = await prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: FEMALE_USER_ID, date: "2026-06-01", deletedAt: null },
    });
    expect(row.flow).toBe("HEAVY");
  });
});

describe("cycle calendar", () => {
  it("runs the engine and goal-gates the fertile window", async () => {
    await loginAs(FEMALE_USER_ID);
    const prisma = getPrismaClient();
    // Three ~28d cycles → a real prediction.
    for (const [start, end, len] of [
      ["2026-01-01", "2026-01-28", 28],
      ["2026-01-29", "2026-02-25", 28],
    ] as const) {
      await prisma.menstrualCycle.create({
        data: {
          userId: FEMALE_USER_ID,
          startDate: start,
          endDate: end,
          lengthDays: len,
          periodEndDate: null,
        },
      });
    }
    await prisma.menstrualCycle.create({
      data: { userId: FEMALE_USER_ID, startDate: "2026-02-26" },
    });

    const { GET } = await import("@/app/api/cycle/calendar/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/cycle/calendar?from=2026-02-20&to=2026-04-15",
      ),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.prediction).not.toBeNull();
    expect(json.data.days.length).toBeGreaterThan(0);
    // GENERAL_HEALTH default → fertile window suppressed.
    expect(json.data.prediction.fertileWindowStart).toBeNull();

    // The read persists nothing. The prediction row exists for the reminder
    // job, and writing it here made the job's behaviour depend on whether
    // anyone had opened this page. Poll anyway rather than reading once, so
    // that a write which merely arrives late still fails the case.
    for (let i = 0; i < 20; i++) {
      const cache = await prisma.cyclePrediction.findUnique({
        where: { userId: FEMALE_USER_ID },
      });
      expect(cache).toBeNull();
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  it("the nightly refresh writes the prediction the read no longer writes", async () => {
    // The other end of the move. Without this the case above would pass
    // against a prediction nothing writes at all.
    //
    // `beforeEach` truncates, so this case seeds its own history rather than
    // inheriting the one above. It also never touches the calendar route: the
    // point is that the prediction lands without anyone opening that page.
    //
    // The profile row is seeded directly for the same reason. Every
    // `/api/cycle/*` route creates one on the way past, so in production the
    // cohort is "has ever used cycle tracking" rather than "opened the
    // calendar recently". Calling a route to get one here would defeat the
    // case.
    const prisma = getPrismaClient();
    await prisma.cycleProfile.create({ data: { userId: FEMALE_USER_ID } });
    for (const [start, end, len] of [
      ["2026-01-01", "2026-01-28", 28],
      ["2026-01-29", "2026-02-25", 28],
    ] as const) {
      await prisma.menstrualCycle.create({
        data: {
          userId: FEMALE_USER_ID,
          startDate: start,
          endDate: end,
          lengthDays: len,
          periodEndDate: null,
        },
      });
    }
    await prisma.menstrualCycle.create({
      data: { userId: FEMALE_USER_ID, startDate: "2026-02-26" },
    });

    expect(
      await prisma.cyclePrediction.findUnique({
        where: { userId: FEMALE_USER_ID },
      }),
    ).toBeNull();

    const { refreshPredictionCacheForUser } =
      await import("@/lib/cycle/prediction-refresh");
    await refreshPredictionCacheForUser(FEMALE_USER_ID);

    expect(
      await prisma.cyclePrediction.findUnique({
        where: { userId: FEMALE_USER_ID },
      }),
    ).not.toBeNull();
  });
});

describe("cycle-prefs gate flip", () => {
  it("enables a MALE account via the prefs PATCH, then admits cycle routes", async () => {
    await loginAs(MALE_USER_ID);
    const { PATCH } = await import("@/app/api/auth/me/cycle-prefs/route");
    const patch = await PATCH(
      jsonRequest("/api/auth/me/cycle-prefs", "PATCH", { enabled: true }),
    );
    expect(patch.status).toBe(200);
    const patchJson = await patch.json();
    expect(patchJson.data.cycleTrackingEnabled).toBe(true);

    // Re-login (fresh session) and confirm the gate now opens.
    await loginAs(MALE_USER_ID);
    const { POST } = await import("@/app/api/cycle/day-logs/route");
    const res = await POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: "2026-03-15",
        flow: "LIGHT",
        loggedAt: "2026-03-15T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(201);
  });

  it("defaults secondarySymptom to MUCUS and persists a switch to CERVIX", async () => {
    await loginAs(FEMALE_USER_ID);
    const { GET, PATCH } = await import("@/app/api/auth/me/cycle-prefs/route");

    const initial = await GET();
    expect((await initial.json()).data.secondarySymptom).toBe("MUCUS");

    const patched = await PATCH(
      jsonRequest("/api/auth/me/cycle-prefs", "PATCH", {
        secondarySymptom: "CERVIX",
      }),
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()).data.secondarySymptom).toBe("CERVIX");
  });
});

describe("sync/changes — cycle domains", () => {
  it("carries cycleDays + cycles upserts and tombstones after a soft-delete", async () => {
    await loginAs(FEMALE_USER_ID);
    const prisma = getPrismaClient();

    const cycle = await prisma.menstrualCycle.create({
      data: { userId: FEMALE_USER_ID, startDate: "2026-03-20" },
    });
    const dayLog = await prisma.cycleDayLog.create({
      data: {
        userId: FEMALE_USER_ID,
        date: "2026-03-20",
        flow: "MEDIUM",
        source: "APPLE_HEALTH",
        externalId: "hk-sync-1",
      },
    });

    const { GET } = await import("@/app/api/sync/changes/route");
    const first = await GET(
      new NextRequest("http://localhost/api/sync/changes"),
    );
    const firstJson = await first.json();
    expect(firstJson.data.changes.cycleDays.upserts.length).toBe(1);
    expect(firstJson.data.changes.cycles.upserts.length).toBe(1);
    expect(firstJson.data.changes.cycleDays.upserts[0].externalId).toBe(
      "hk-sync-1",
    );

    // Soft-delete both → next pull surfaces tombstones.
    await prisma.cycleDayLog.update({
      where: { id: dayLog.id },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });
    await prisma.menstrualCycle.update({
      where: { id: cycle.id },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });

    const second = await GET(
      new NextRequest("http://localhost/api/sync/changes"),
    );
    const secondJson = await second.json();
    const dayTombs = secondJson.data.changes.cycleDays.tombstones;
    const cycleTombs = secondJson.data.changes.cycles.tombstones;
    expect(dayTombs.length).toBe(1);
    expect(dayTombs[0].externalId).toBe("hk-sync-1");
    expect(cycleTombs.length).toBe(1);
    expect(cycleTombs[0].id).toBe(cycle.id);
  });
});

describe("back-filling an entry months into the past", () => {
  /** `YYYY-MM-DD`, `days` from today, in the process zone the route resolves. */
  function dayKey(offset: number): string {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  }

  // Far enough back to fall outside the page's anchored ninety-day read, the
  // way an April entry does in August. Dates are relative so the case cannot
  // slide out of the window it is about as the calendar moves on.
  const BACK_DATED = dayKey(-111);

  it("writes the day and hands it back on a window that covers it", async () => {
    await loginAs(FEMALE_USER_ID);
    const prisma = getPrismaClient();

    const dayLogs = await import("@/app/api/cycle/day-logs/route");
    const written = await dayLogs.POST(
      jsonRequest("/api/cycle/day-logs", "POST", {
        date: BACK_DATED,
        flow: "HEAVY",
        loggedAt: `${BACK_DATED}T08:00:00.000Z`,
      }),
    );
    // The route accepts a past date: only the future is refused.
    expect(written.status).toBe(201);

    // The row is really there, not just an accepted response.
    const row = await prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: FEMALE_USER_ID, date: BACK_DATED, deletedAt: null },
    });
    expect(row.flow).toBe("HEAVY");

    const { GET } = await import("@/app/api/cycle/calendar/route");
    // The page's own window. The entry exists and this read cannot show it,
    // which is the whole of what the client saw as "nothing was saved".
    const anchored = await GET(
      new NextRequest(
        `http://localhost/api/cycle/calendar?from=${dayKey(-90)}&to=${dayKey(180)}`,
      ),
    );
    const anchoredDays = (await anchored.json()).data.days as {
      date: string;
    }[];
    expect(anchoredDays.some((d) => d.date === BACK_DATED)).toBe(false);

    // A window over the month the grid is showing carries it, flow and all.
    const month = BACK_DATED.slice(0, 7);
    const lastDay = new Date(
      Number(month.slice(0, 4)),
      Number(month.slice(5, 7)),
      0,
    ).getDate();
    const scoped = await GET(
      new NextRequest(
        `http://localhost/api/cycle/calendar?from=${month}-01&to=${month}-${lastDay}`,
      ),
    );
    expect(scoped.status).toBe(200);
    const scopedDays = (await scoped.json()).data.days as {
      date: string;
      flow: string | null;
      isPeriodLogged: boolean;
    }[];
    const hit = scopedDays.find((d) => d.date === BACK_DATED);
    expect(hit).toBeDefined();
    expect(hit?.flow).toBe("HEAVY");
    expect(hit?.isPeriodLogged).toBe(true);
  });

  it("opens a back-dated cycle and marks the day as its start", async () => {
    await loginAs(FEMALE_USER_ID);
    const period = await import("@/app/api/cycle/period/route");
    const res = await period.POST(
      jsonRequest("/api/cycle/period", "POST", {
        action: "start",
        date: BACK_DATED,
        loggedAt: `${BACK_DATED}T08:00:00.000Z`,
      }),
    );
    expect(res.status).toBe(200);

    const month = BACK_DATED.slice(0, 7);
    const lastDay = new Date(
      Number(month.slice(0, 4)),
      Number(month.slice(5, 7)),
      0,
    ).getDate();
    const { GET } = await import("@/app/api/cycle/calendar/route");
    const scoped = await GET(
      new NextRequest(
        `http://localhost/api/cycle/calendar?from=${month}-01&to=${month}-${lastDay}`,
      ),
    );
    const days = (await scoped.json()).data.days as {
      date: string;
      isCycleStart: boolean;
    }[];
    // The flag the log sheet reads to say what a delete would take.
    expect(days.find((d) => d.date === BACK_DATED)?.isCycleStart).toBe(true);
    expect(days.filter((d) => d.isCycleStart)).toHaveLength(1);
  });
});
