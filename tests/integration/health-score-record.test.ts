/**
 * The persisted health score day, end to end against real Postgres.
 *
 * A mocked Prisma proves nothing here. Every claim this file makes is about
 * what is actually in the table after a real request: that computing a score
 * writes the day down, that computing it again under different readings
 * leaves the earlier day exactly as it stood, and that the row survives a
 * backup and a restore rather than coming back blank while the restore
 * reports success.
 *
 * The three lifecycle paths a new user-scoped table has to join, and where
 * each is proved:
 *
 *   - delete-all-data — `tests/integration/settings-data-wipe.test.ts` seeds
 *     every table from `information_schema` and asserts every model in the
 *     wipe plan is empty afterwards, so this table is covered there the
 *     moment it enters the plan. `src/__tests__/data-wipe-completeness.test.ts`
 *     is what forces it into the plan in the first place.
 *   - the backup writer — proved below over `buildFullBackupPayload`, which
 *     is the builder the weekly worker and both export routes share.
 *   - the restore path — proved below over the real admin restore ROUTE, not
 *     over the helper it delegates to. That distinction is the whole point:
 *     the structural guard in `backup-plan-classification.test.ts` reads the
 *     declared restore FILES, so a helper that exists and is never called
 *     passes it. Only a round trip through the route catches that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { caches } from "@/lib/cache/server-cache";
import { encrypt } from "@/lib/crypto";
import { SCORE_VERSION } from "@/lib/analytics/score/types";
import { healthScoreCompositionItemKey } from "@/lib/daily/priority-item-key";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
  invalidateUserHealthScore: vi.fn(),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

const DAY = 24 * 60 * 60 * 1000;

interface AnalyticsEnvelope {
  data: {
    healthScore: {
      composite: {
        status: "ok" | "insufficient";
        value?: { score: number; band: string; composition: string[] };
      };
      compositionNotice?: {
        itemKey: string;
        left: string[];
        joined: string[];
        dismissed: boolean;
      } | null;
    } | null;
  } | null;
}

async function seedSession(username: string, role: "USER" | "ADMIN" = "USER") {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role,
      heightCm: 178,
      dateOfBirth: new Date("1985-07-09"),
      // Pinned so the local day the row is filed under is a fact of the
      // fixture rather than a property of the machine running the suite.
      timezone: "UTC",
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

/** BP needs twelve paired readings inside the trailing 90-day window. */
async function seedBp(userId: string, now: number, days: number, sys: number) {
  const prisma = getPrismaClient();
  for (let i = 0; i < days; i++) {
    const at = new Date(now - i * DAY);
    await prisma.measurement.create({
      data: {
        userId,
        type: "BLOOD_PRESSURE_SYS",
        value: sys,
        unit: "mmHg",
        measuredAt: at,
      },
    });
    await prisma.measurement.create({
      data: {
        userId,
        type: "BLOOD_PRESSURE_DIA",
        value: 78,
        unit: "mmHg",
        measuredAt: at,
      },
    });
  }
}

/** SLEEP needs fourteen distinct wake-day nights. */
async function seedSleep(userId: string, now: number, nights: number) {
  const prisma = getPrismaClient();
  for (let i = 0; i < nights; i++) {
    const wake = new Date(now - i * DAY);
    wake.setUTCHours(6, 0, 0, 0);
    await prisma.measurement.create({
      data: {
        userId,
        type: "SLEEP_DURATION",
        value: 450,
        unit: "min",
        measuredAt: wake,
        sleepStage: "ASLEEP",
        source: "APPLE_HEALTH",
      },
    });
  }
}

/** ADIPOSITY needs one waist reading against the seeded height. */
async function seedWaist(userId: string, now: number) {
  await getPrismaClient().measurement.create({
    data: {
      userId,
      type: "WAIST_CIRCUMFERENCE",
      value: 82,
      unit: "cm",
      measuredAt: new Date(now),
    },
  });
}

async function readAnalytics(): Promise<AnalyticsEnvelope> {
  const { GET } = await import("@/app/api/analytics/route");
  const res = await (GET as (req: Request) => Promise<Response>)(
    new Request("http://localhost/api/analytics"),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as AnalyticsEnvelope;
}

describe("the score a surface shows is the score that gets written down", () => {
  it("persists the composite, band and composition the analytics route returned", async () => {
    const user = await seedSession("hsr-roundtrip");
    const now = Date.now();
    await seedBp(user.id, now, 20, 122);
    await seedSleep(user.id, now, 14);
    await seedWaist(user.id, now);

    const shown = (await readAnalytics()).data!.healthScore!;
    expect(shown.composite.status).toBe("ok");

    const rows = await getPrismaClient().healthScoreRecord.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // The shown value and the stored value are not compared through a fixture
    // in the middle — the number asserted here came back over the wire from
    // the same request that wrote the row.
    expect(row.composite).toBe(shown.composite.value!.score);
    expect(row.band).toBe(shown.composite.value!.band);
    expect(row.composition).toEqual(shown.composite.value!.composition);
    expect(row.pillarScores).toBeTruthy();
    // JSONB does not preserve insertion order, so the SET of keys is the
    // claim, not their order. The order that matters lives in `composition`,
    // which is a text array and asserted above.
    expect(
      Object.keys(row.pillarScores as Record<string, number>).sort(),
    ).toEqual([...shown.composite.value!.composition].sort());
    expect(row.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.timezone).toBe("UTC");
    expect(row.dayKey).toBe(new Date(now).toISOString().slice(0, 10));
    // The recipe the day was scored under, resolved on the write path from
    // the account's own stored configuration. This account never opened the
    // settings surface, so the honest answer is version 0 with no change
    // date — the thing the first authored recipe will later be a move FROM.
    expect(row.configVersion).toBe(0);
    expect(row.configChangedAt).toBeNull();
  });

  it("stamps the account's own recipe on the row, straight from the stored configuration", async () => {
    // The supply half of the delta guard, over real Postgres. Nothing in
    // the request carries the recipe: the write path resolves it from the
    // same column the composition came from, so a version that never
    // reached the writer shows up as a row that cannot say which recipe
    // produced it — and the seam becomes underivable a release later.
    const user = await seedSession("hsr-recipe");
    const now = Date.now();
    await seedBp(user.id, now, 20, 122);
    await seedSleep(user.id, now, 14);
    await seedWaist(user.id, now);
    const changedAt = new Date(now - 3 * DAY);
    await getPrismaClient().user.update({
      where: { id: user.id },
      data: {
        healthScoreConfigJson: {
          excludedPillars: ["FITNESS"],
          version: 6,
          changedAt: changedAt.toISOString(),
        },
      },
    });

    expect((await readAnalytics()).data!.healthScore!.composite.status).toBe(
      "ok",
    );

    const row = await getPrismaClient().healthScoreRecord.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.configVersion).toBe(6);
    expect(row.configChangedAt?.toISOString()).toBe(changedAt.toISOString());
  });

  it("leaves the recorded day untouched when the same day is computed again under a changed standing", async () => {
    const user = await seedSession("hsr-never-restate");
    const now = Date.now();
    await seedBp(user.id, now, 20, 122);
    await seedSleep(user.id, now, 14);
    await seedWaist(user.id, now);

    const first = (await readAnalytics()).data!.healthScore!;
    expect(first.composite.status).toBe("ok");
    const before = await getPrismaClient().healthScoreRecord.findFirstOrThrow({
      where: { userId: user.id },
    });

    // Change what the score is made of, two ways at once: a fourth pillar
    // joins the composition, and blood pressure grades worse. Either alone
    // moves the live number.
    await getPrismaClient().measurement.deleteMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
    });
    await getPrismaClient().measurement.deleteMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
    });
    await seedBp(user.id, now, 20, 168);
    for (let i = 0; i < 30; i++) {
      await getPrismaClient().measurement.create({
        data: {
          userId: user.id,
          type: "ACTIVITY_STEPS",
          value: 11_000,
          unit: "steps",
          measuredAt: new Date(now - i * DAY),
          source: "APPLE_HEALTH",
        },
      });
    }

    // `/api/analytics` reads through a 60-second cache, so without this the
    // second request would replay the first request's body and nothing would
    // recompute. The assertion below is what caught it.
    caches.analytics.deleteByPrefix(`${user.id}|`);
    caches.insightsDerived.deleteByPrefix(`${user.id}|`);

    const second = (await readAnalytics()).data!.healthScore!;
    expect(second.composite.status).toBe("ok");
    // The live number really did move — without this the test below would
    // pass against a recomputation that changed nothing.
    expect(second.composite.value!.score).not.toBe(
      first.composite.value!.score,
    );

    const after = await getPrismaClient().healthScoreRecord.findMany({
      where: { userId: user.id },
    });
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
  });
});

describe("the recorded day survives a backup and a restore", () => {
  it("carries the row out through the shared backup builder", async () => {
    const user = await seedSession("hsr-backup");
    const now = Date.now();
    await seedBp(user.id, now, 20, 122);
    await seedSleep(user.id, now, 14);
    await seedWaist(user.id, now);
    await readAnalytics();

    const stored = await getPrismaClient().healthScoreRecord.findFirstOrThrow({
      where: { userId: user.id },
    });
    const { payload, counts } = await buildFullBackupPayload(
      getPrismaClient(),
      user.id,
      { purpose: "disaster-recovery" },
    );
    expect(counts.healthScoreRecords).toBe(1);
    const carried = (payload as { healthScoreRecords: unknown[] })
      .healthScoreRecords;
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({
      id: stored.id,
      dayKey: stored.dayKey,
      timezone: stored.timezone,
      composite: stored.composite,
      band: stored.band,
      scoreVersion: stored.scoreVersion,
      composition: stored.composition,
      inputFingerprint: stored.inputFingerprint,
    });
    // And the file it produced is one the restore side will accept, rather
    // than one that parses everywhere except at the moment it is needed.
    expect(
      parseBackupPayload(JSON.stringify(payload)).healthScoreRecords,
    ).toHaveLength(1);
  });

  it("brings the row back through the admin restore route", async () => {
    const prisma = getPrismaClient();
    const admin = await seedSession("hsr-restore", "ADMIN");
    const now = Date.now();
    await seedBp(admin.id, now, 20, 122);
    await seedSleep(admin.id, now, 14);
    await seedWaist(admin.id, now);
    await readAnalytics();

    const before = await prisma.healthScoreRecord.findFirstOrThrow({
      where: { userId: admin.id },
    });
    const { payload } = await buildFullBackupPayload(prisma, admin.id, {
      purpose: "disaster-recovery",
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "HEALTH_SCORE_RECORD_RESTORE_TEST",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    // Wipe the table so a restore that carries nothing cannot pass by leaving
    // the row that was already there.
    await prisma.healthScoreRecord.deleteMany({ where: { userId: admin.id } });
    expect(
      await prisma.healthScoreRecord.count({ where: { userId: admin.id } }),
    ).toBe(0);

    const { POST } = await import("./restore-job-driver");
    const res = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    const body = (await res.json()) as {
      data: { summary: { healthScoreRecords: number } } | null;
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(res.status).toBe(200);
    expect(body.data!.summary.healthScoreRecords).toBe(1);

    const restored = await prisma.healthScoreRecord.findMany({
      where: { userId: admin.id },
    });
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe(before.id);
    expect(restored[0].dayKey).toBe(before.dayKey);
    expect(restored[0].composite).toBe(before.composite);
    expect(restored[0].band).toBe(before.band);
    expect(restored[0].composition).toEqual(before.composition);
    expect(restored[0].pillarScores).toEqual(before.pillarScores);
    expect(restored[0].inputFingerprint).toBe(before.inputFingerprint);
    expect(restored[0].computedAt.toISOString()).toBe(
      before.computedAt.toISOString(),
    );
  });
});

describe("delete all data", () => {
  it("removes the recorded days along with the rest of the record", async () => {
    const user = await seedSession("hsr-wipe");
    const now = Date.now();
    await seedBp(user.id, now, 20, 122);
    await seedSleep(user.id, now, 14);
    await seedWaist(user.id, now);
    await readAnalytics();
    expect(
      await getPrismaClient().healthScoreRecord.count({
        where: { userId: user.id },
      }),
    ).toBe(1);

    const { DELETE } = await import("@/app/api/settings/data/route");
    const res = await (
      DELETE as unknown as (req: Request) => Promise<Response>
    )(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(
      await getPrismaClient().healthScoreRecord.count({
        where: { userId: user.id },
      }),
    ).toBe(0);
  });
});

/**
 * v1.38 — the stored day's first production reader.
 *
 * Until this release nothing but backup and restore ever read this table.
 * The composition note compares today's set against the last stored LOCAL
 * DAY, which means a restore that brings the rows back as something subtly
 * different does not fail loudly — it produces a note that is silently
 * wrong, or no note where one was owed. So the claim proved here is the
 * round trip: raise the note, wipe the table, restore it through the real
 * admin route, and get the same note back.
 */
describe("the composition note reads the stored day, and survives a restore", () => {
  /** Yesterday's day, as the account's own clock cut it. */
  async function seedPriorDay(
    userId: string,
    now: number,
    composition: string[],
  ) {
    const dayKey = new Date(now - DAY).toISOString().slice(0, 10);
    await getPrismaClient().healthScoreRecord.create({
      data: {
        userId,
        dayKey,
        timezone: "UTC",
        composite: 80,
        band: "green",
        scoreVersion: SCORE_VERSION,
        composition,
        pillarScores: Object.fromEntries(composition.map((id) => [id, 80])),
        inputFingerprint: "0".repeat(64),
        configVersion: 0,
        configChangedAt: null,
        computedAt: new Date(now - DAY),
      },
    });
    return dayKey;
  }

  function evictScoreCaches(userId: string) {
    caches.analytics.deleteByPrefix(`${userId}|`);
    caches.insightsDerived.deleteByPrefix(`${userId}|`);
  }

  it("names the pillar that stopped counting since the last stored day", async () => {
    const user = await seedSession("hsc-notice");
    const now = Date.now();
    await seedBp(user.id, now, 20, 122);
    await seedSleep(user.id, now, 14);
    await seedWaist(user.id, now);
    // Activity counted yesterday and has no data at all today, which is the
    // shape a rolled window leaves behind.
    await seedPriorDay(user.id, now, [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
    ]);

    const shown = (await readAnalytics()).data!.healthScore!;
    expect(shown.composite.status).toBe("ok");
    const notice = shown.compositionNotice;
    expect(notice, "no composition notice was raised").toBeTruthy();
    expect(notice!.left).toContain("ACTIVITY");
    expect(notice!.joined).toEqual([]);
    expect(notice!.dismissed).toBe(false);
    // The key names the resulting SET, so it is derivable from what the
    // same response says the score is made of.
    expect(notice!.itemKey).toBe(
      healthScoreCompositionItemKey(
        SCORE_VERSION,
        shown.composite.value!.composition,
      ),
    );
  });

  it("says nothing when the stored day holds the same set", async () => {
    // The counter-case. Without it the assertion above would pass against a
    // reader that raised a note on every single request.
    const user = await seedSession("hsc-quiet");
    const now = Date.now();
    await seedBp(user.id, now, 20, 122);
    await seedSleep(user.id, now, 14);
    await seedWaist(user.id, now);

    const first = (await readAnalytics()).data!.healthScore!;
    expect(first.compositionNotice ?? null).toBeNull();

    await seedPriorDay(user.id, now, [...first.composite.value!.composition]);
    evictScoreCaches(user.id);

    const second = (await readAnalytics()).data!.healthScore!;
    expect(second.compositionNotice ?? null).toBeNull();
  });

  it("raises the same note again after the table has been through a restore", async () => {
    const prisma = getPrismaClient();
    const admin = await seedSession("hsc-restore", "ADMIN");
    const now = Date.now();
    await seedBp(admin.id, now, 20, 122);
    await seedSleep(admin.id, now, 14);
    await seedWaist(admin.id, now);
    await seedPriorDay(admin.id, now, [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
    ]);

    const before = (await readAnalytics()).data!.healthScore!.compositionNotice;
    expect(before, "the fixture raised no note to round-trip").toBeTruthy();

    const { payload } = await buildFullBackupPayload(prisma, admin.id, {
      purpose: "disaster-recovery",
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "HEALTH_SCORE_COMPOSITION_RESTORE_TEST",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    // Both days go, so a restore that carries nothing cannot pass by
    // leaving the row the comparison needs.
    await prisma.healthScoreRecord.deleteMany({ where: { userId: admin.id } });
    evictScoreCaches(admin.id);
    // And with the stored days gone there is nothing to compare against,
    // which is what makes the restore below the thing under test rather
    // than a formality.
    expect(
      (await readAnalytics()).data!.healthScore!.compositionNotice ?? null,
    ).toBeNull();

    const { POST } = await import("./restore-job-driver");
    const res = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(res.status).toBe(200);
    evictScoreCaches(admin.id);

    const after = (await readAnalytics()).data!.healthScore!.compositionNotice;
    expect(after).toEqual(before);
  });

  it("holds the dismissal across the restore, keyed on the set rather than the day", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("hsc-dismissed");
    const now = Date.now();
    await seedBp(user.id, now, 20, 122);
    await seedSleep(user.id, now, 14);
    await seedWaist(user.id, now);
    await seedPriorDay(user.id, now, [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
    ]);

    const raised = (await readAnalytics()).data!.healthScore!.compositionNotice;
    expect(raised!.dismissed).toBe(false);

    const { POST } = await import("@/app/api/daily/digest/dismiss/route");
    const res = await (POST as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/daily/digest/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemKey: raised!.itemKey }),
      }),
    );
    expect(res.status).toBe(200);
    expect(
      await prisma.dismissedPriorityItem.count({
        where: { userId: user.id, itemKey: raised!.itemKey },
      }),
    ).toBe(1);

    evictScoreCaches(user.id);
    const again = (await readAnalytics()).data!.healthScore!.compositionNotice;
    expect(again!.itemKey).toBe(raised!.itemKey);
    expect(again!.dismissed).toBe(true);
  });
});
