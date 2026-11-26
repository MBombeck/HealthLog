/**
 * The morning read on seeded records, against real Postgres.
 *
 * The unit table pins the rules on hand-built inputs. This one runs the whole
 * read (the snapshot, the coincident engine, readiness and the sleep score,
 * the floor ledger, the quiet-source stamps, the episode and visit tables) on
 * real rows and checks each answer against the published schema: a proxy
 * account, a WHOOP account, Rest mode, a quiet iPhone on its first and its
 * third day, a confirmed safety floor, and an empty account. Readiness in the
 * morning is the readiness the derived batch route serves.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { loadDailyMorning } from "@/lib/daily/morning-load";
import { dailyMorningResponse } from "@/lib/openapi/routes/daily";

import { hashToken } from "@/lib/auth/hmac";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

const TZ = "Europe/Berlin";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// 08:00 in Berlin on a Thursday morning.
const NOW = new Date("2026-11-26T07:00:00.000Z");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  __resetAllCachesForTests();
  cookieJar.clear();
  headerJar.clear();
});

async function seedUser(
  id: string,
  extra: Partial<Prisma.UserCreateInput> = {},
) {
  return getPrismaClient().user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      timezone: TZ,
      gender: "FEMALE",
      dateOfBirth: new Date("1985-05-05T00:00:00.000Z"),
      ...extra,
    },
  });
}

async function fullUser(id: string) {
  return getPrismaClient().user.findUniqueOrThrow({ where: { id } });
}

/** A month of steady values for each type, then today's reading. */
async function seedSeries(
  userId: string,
  series: Array<{
    type: Prisma.MeasurementCreateManyInput["type"];
    unit: string;
    base: number;
    today?: number;
    source?: Prisma.MeasurementCreateManyInput["source"];
  }>,
) {
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  for (const s of series) {
    for (let d = 30; d >= 1; d--) {
      rows.push({
        userId,
        type: s.type,
        value: s.base + (d % 3),
        unit: s.unit,
        measuredAt: new Date(NOW.getTime() - d * DAY),
        source: s.source ?? "MANUAL",
      });
    }
    if (s.today !== undefined) {
      rows.push({
        userId,
        type: s.type,
        value: s.today,
        unit: s.unit,
        measuredAt: new Date(NOW.getTime() - HOUR),
        source: s.source ?? "MANUAL",
      });
    }
  }
  await getPrismaClient().measurement.createMany({ data: rows });
}

function expectValid(morning: unknown) {
  const parsed = dailyMorningResponse.safeParse(
    JSON.parse(JSON.stringify(morning)),
  );
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
}

describe("the morning read on a real record", () => {
  it("answers an empty account with rank 10 and no cards", async () => {
    await seedUser("m-empty");
    const morning = await loadDailyMorning(await fullUser("m-empty"), NOW, {
      locale: "en",
    });
    expectValid(morning);
    expect(morning.lead).toMatchObject({ rank: 10, key: "nothing" });
    expect(morning.lead.text).toBe("No readings yet today.");
    expect(morning.cards).toEqual([]);
  });

  it("counts blood pressure and heart rate as two signals (rank 2)", async () => {
    await seedUser("m-proxy");
    await seedSeries("m-proxy", [
      { type: "BLOOD_PRESSURE_SYS", unit: "mmHg", base: 118, today: 150 },
      { type: "BLOOD_PRESSURE_DIA", unit: "mmHg", base: 76, today: 98 },
      { type: "RESTING_HEART_RATE", unit: "bpm", base: 52, today: 68 },
      { type: "HEART_RATE_VARIABILITY", unit: "ms", base: 48, today: 49 },
    ]);
    const morning = await loadDailyMorning(await fullUser("m-proxy"), NOW, {
      locale: "en",
    });
    expectValid(morning);
    expect(morning.lead).toMatchObject({ rank: 2, key: "coincident" });
    expect(morning.lead.text).toBe(
      "Blood pressure and heart rate are outside your usual range today.",
    );
    const today = morning.cards.find((c) => c.kind === "today_different");
    expect(today?.href).toBe("/insights");
    expect(today?.lines.length).toBe(3);
  });

  it("reads a cuff alone as one signal (rank 3, not 2)", async () => {
    await seedUser("m-cuff");
    await seedSeries("m-cuff", [
      { type: "BLOOD_PRESSURE_SYS", unit: "mmHg", base: 118, today: 150 },
      { type: "BLOOD_PRESSURE_DIA", unit: "mmHg", base: 76, today: 98 },
    ]);
    const morning = await loadDailyMorning(await fullUser("m-cuff"), NOW, {
      locale: "en",
    });
    expect(morning.lead).toMatchObject({ rank: 3, key: "vital_outside" });
    expect(morning.lead.text).toMatch(/blood pressure averages \d+ mmHg today/);
  });

  it("serves the readiness the derived batch route serves", async () => {
    const user = await seedUser("m-ready");
    await seedSeries("m-ready", [
      { type: "RESTING_HEART_RATE", unit: "bpm", base: 52, today: 54 },
      { type: "HEART_RATE_VARIABILITY", unit: "ms", base: 48, today: 47 },
      { type: "RESPIRATORY_RATE", unit: "br/min", base: 14, today: 14 },
    ]);
    const session = await getPrismaClient().session.create({
      // Valid at the pinned clock below, whatever the real one says.
      data: { userId: user.id, expiresAt: new Date(NOW.getTime() + DAY) },
    });
    cookieJar.set("healthlog_session", session.id);

    // Both read at the same instant: the route reads the clock itself.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const { GET } = await import("@/app/api/insights/derived/batch/route");
      const res = await (
        GET as unknown as (r: NextRequest) => Promise<Response>
      )(
        new NextRequest(
          "http://localhost/api/insights/derived/batch?metrics=READINESS",
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          metrics: Record<
            string,
            { status: string; value: { score: number } | null }
          >;
        };
      };
      const batch = body.data.metrics.READINESS;
      expect(batch.status).toBe("ok");
      const score = Math.round(batch.value!.score);

      __resetAllCachesForTests();
      const morning = await loadDailyMorning(await fullUser(user.id), NOW, {
        locale: "en",
      });
      expectValid(morning);
      const card = morning.cards.find((c) => c.kind === "today_different");
      expect(card?.ring).not.toBeNull();
      if (card?.ring?.fresh) {
        expect(card.ring.score).toBe(score);
      } else {
        // Not fresh: no number in the ring, the value named as past.
        expect(card?.ring?.score).toBeNull();
        expect(card?.ring?.band).toBeNull();
        if (card?.ring?.asOfDay) {
          expect(card.lines[0]?.text).toContain(String(score));
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a WHOOP account's recovery under WHOOP's name, without a band", async () => {
    await seedUser("m-whoop");
    await getPrismaClient().measurement.createMany({
      data: [
        {
          userId: "m-whoop",
          type: "RECOVERY_SCORE",
          value: 71,
          unit: "score",
          measuredAt: new Date(NOW.getTime() - 2 * HOUR),
          source: "WHOOP",
        },
        {
          userId: "m-whoop",
          type: "RECOVERY_SCORE",
          value: 60,
          unit: "score",
          measuredAt: new Date(NOW.getTime() - 3 * HOUR),
          source: "POLAR",
        },
      ],
    });
    const morning = await loadDailyMorning(await fullUser("m-whoop"), NOW, {
      locale: "en",
    });
    expectValid(morning);
    const card = morning.cards.find((c) => c.kind === "today_different");
    expect(card?.sourceValues).toEqual([
      expect.objectContaining({
        source: "WHOOP",
        label: "WHOOP Recovery",
        value: 71,
        scaleMax: 100,
      }),
      expect.objectContaining({
        source: "POLAR",
        label: "Polar Nightly Recharge",
        value: 4,
        scaleMax: 6,
      }),
    ]);
    expect(JSON.stringify(card?.sourceValues)).not.toContain("band");
  });

  it("says Rest mode first (rank 1), and drops the band", async () => {
    await seedUser("m-rest");
    await seedSeries("m-rest", [
      { type: "RESTING_HEART_RATE", unit: "bpm", base: 52, today: 70 },
      { type: "HEART_RATE_VARIABILITY", unit: "ms", base: 48, today: 30 },
    ]);
    await getPrismaClient().illnessEpisode.create({
      data: {
        userId: "m-rest",
        label: "Cold",
        type: "INFECTION",
        onsetAt: new Date("2026-11-23T18:00:00.000Z"),
      },
    });
    const morning = await loadDailyMorning(await fullUser("m-rest"), NOW, {
      locale: "en",
    });
    expectValid(morning);
    expect(morning.lead).toMatchObject({ rank: 1, key: "rest_mode" });
    expect(morning.lead.text).toBe(
      "Rest mode for 3 days, so today's readings serve only as context.",
    );
  });

  it("names a quiet iPhone on its first day and leaves the third to the rail", async () => {
    for (const [id, quietHours] of [
      ["m-quiet-1", 30],
      ["m-quiet-3", 80],
    ] as const) {
      await seedUser(id);
      await getPrismaClient().device.create({
        data: {
          userId: id,
          platform: "ios",
          token: `token-${id}`,
          bundleId: "dev.healthlog.app",
          healthIngestAt: new Date(NOW.getTime() - quietHours * HOUR),
          healthQuietSince: new Date(NOW.getTime() - quietHours * HOUR),
        },
      });
    }
    const first = await loadDailyMorning(await fullUser("m-quiet-1"), NOW, {
      locale: "en",
    });
    expectValid(first);
    expect(first.lead).toMatchObject({ rank: 5, key: "source_quiet" });
    expect(first.lead.text).toBe("Apple Health has sent nothing for 30 hours.");

    const third = await loadDailyMorning(await fullUser("m-quiet-3"), NOW, {
      locale: "en",
    });
    expect(third.lead.key).not.toBe("source_quiet");
  });

  it("answers a confirmed floor with its reading (rank 0)", async () => {
    await seedUser("m-floor");
    await seedSeries("m-floor", [
      { type: "BLOOD_PRESSURE_SYS", unit: "mmHg", base: 118 },
      { type: "BLOOD_PRESSURE_DIA", unit: "mmHg", base: 76 },
    ]);
    const prisma = getPrismaClient();
    for (const [sys, dia, minutes] of [
      [184, 122, 90],
      [181, 118, 80],
    ] as const) {
      const at = new Date(NOW.getTime() - minutes * 60_000);
      await prisma.measurement.createMany({
        data: [
          {
            userId: "m-floor",
            type: "BLOOD_PRESSURE_SYS",
            value: sys,
            unit: "mmHg",
            measuredAt: at,
          },
          {
            userId: "m-floor",
            type: "BLOOD_PRESSURE_DIA",
            value: dia,
            unit: "mmHg",
            measuredAt: at,
          },
        ],
      });
    }
    await prisma.notificationEvent.create({
      data: {
        recordUserId: "m-floor",
        eventType: "SYSTEM_ALERT",
        dedupKey: "safety_floor:bp_hypertensive",
        createdAt: new Date(NOW.getTime() - 80 * 60_000),
      },
    });
    const morning = await loadDailyMorning(await fullUser("m-floor"), NOW, {
      locale: "en",
    });
    expectValid(morning);
    expect(morning.lead).toMatchObject({ rank: 0, key: "floor" });
    expect(morning.lead.text).toBe(
      "Blood pressure reached 184/122 mmHg in the last 24 hours.",
    );
  });

  it("names an unconfirmed reading past a floor instead of an all-clear (rank 3)", async () => {
    // A personal range that runs high: 182/121 sits inside it, so the
    // counted vitals alone would read "in range". No ledger row yet.
    await seedUser("m-floor-open");
    await seedSeries("m-floor-open", [
      { type: "BLOOD_PRESSURE_SYS", unit: "mmHg", base: 178 },
      { type: "BLOOD_PRESSURE_DIA", unit: "mmHg", base: 118 },
    ]);
    const at = new Date(NOW.getTime() - 60 * 60_000);
    await getPrismaClient().measurement.createMany({
      data: [
        {
          userId: "m-floor-open",
          type: "BLOOD_PRESSURE_SYS",
          value: 182,
          unit: "mmHg",
          measuredAt: at,
        },
        {
          userId: "m-floor-open",
          type: "BLOOD_PRESSURE_DIA",
          value: 121,
          unit: "mmHg",
          measuredAt: at,
        },
      ],
    });
    const morning = await loadDailyMorning(
      await fullUser("m-floor-open"),
      NOW,
      { locale: "en" },
    );
    expectValid(morning);
    expect(morning.lead.key).not.toBe("in_range");
    expect(morning.lead.text).toBe(
      "Blood pressure reached 182/121 mmHg in the last 24 hours.",
    );
  });

  it("words every text in the app's language on a Bearer request, else the account's", async () => {
    await seedUser("m-bearer", { locale: "fr" });
    const raw = "hlk_morning-bearer".padEnd(20, "0");
    await getPrismaClient().apiToken.create({
      data: {
        userId: "m-bearer",
        name: "morning-language",
        tokenHash: hashToken(raw),
        permissions: ["*"],
      },
    });
    headerJar.set("authorization", `Bearer ${raw}`);
    const { GET } = await import("@/app/api/daily/morning/route");
    const call = async (acceptLanguage: string | null) => {
      const headers = new Headers({ authorization: `Bearer ${raw}` });
      if (acceptLanguage) headers.set("accept-language", acceptLanguage);
      const res = await (
        GET as unknown as (r: NextRequest) => Promise<Response>
      )(new NextRequest("http://localhost/api/daily/morning", { headers }));
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: unknown }).data as {
        lead: { text: string; language: string };
        toDo: { titleKey: string; title: string };
      };
    };

    const german = await call("de-DE,de;q=0.9");
    expectValid(german);
    expect(german.lead).toMatchObject({
      language: "de",
      text: "Heute noch keine Werte.",
    });
    expect(german.toDo).toEqual({
      titleKey: "daily.morningCard.title.toDo",
      title: "Heute zu tun",
    });

    // No shipped language in the header: the account's, never English.
    for (const header of [null, "sv-SE"]) {
      const french = await call(header);
      expect(french.lead).toMatchObject({
        language: "fr",
        text: "Pas encore de valeurs aujourd'hui.",
      });
      expect(french.toDo.title).toBe("À faire aujourd'hui");
    }
  });
});
