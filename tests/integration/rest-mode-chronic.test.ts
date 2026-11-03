/**
 * #1216 — a chronic ongoing condition alone never puts the account into Rest
 * Mode, against real Postgres.
 *
 * A CHRONIC_ONGOING episode has no end date by design, so counting it would
 * put the account into Rest Mode for good: the Today strip read "Rest mode ·
 * Day 3948", nudges stayed paused and every streak gap since the onset was
 * bridged. Pinned here on the three readers that decide it: the resolver
 * (which the score, recovery, nudge and Today surfaces read), the Today
 * digest's Day N, and the achievements streak freeze, which runs its own
 * episode query.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import { buildAchievementsResult } from "@/lib/gamification/achievements-result";
import { REST_MODE_INACTIVE, resolveRestMode } from "@/lib/illness/rest-mode";
import type { ModuleKey } from "@/lib/modules/registry";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "rest-mode-chronic";
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  __resetAllCachesForTests();
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: "UTC",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    },
  });
});

function episode(data: Partial<Prisma.IllnessEpisodeUncheckedCreateInput>) {
  return getPrismaClient().illnessEpisode.create({
    data: {
      userId: USER,
      label: "Condition",
      type: "CHRONIC",
      lifecycle: "CHRONIC_ONGOING",
      onsetAt: new Date("2015-08-01T00:00:00.000Z"),
      ...data,
    },
  });
}

describe("resolveRestMode on a real record", () => {
  const NOW = new Date("2026-10-04T12:00:00.000Z");

  it("a chronic condition alone is not Rest Mode", async () => {
    await episode({});
    expect(await resolveRestMode(USER, NOW, getPrismaClient())).toEqual(
      REST_MODE_INACTIVE,
    );
  });

  it("chronic + acute is Rest Mode, anchored on the acute onset", async () => {
    await episode({});
    const acute = await episode({
      label: "Cold",
      type: "INFECTION",
      lifecycle: "ACUTE",
      onsetAt: new Date("2026-10-02T18:00:00.000Z"),
    });
    const ctx = await resolveRestMode(USER, NOW, getPrismaClient());
    expect(ctx.active).toBe(true);
    expect(ctx.since).toBe("2026-10-02T18:00:00.000Z");
    expect(ctx.episodes.map((e) => e.id)).toEqual([acute.id]);
  });

  it("a flare threaded under the chronic condition is Rest Mode", async () => {
    const parent = await episode({});
    await episode({
      label: "Flare",
      lifecycle: "FLARE",
      parentConditionId: parent.id,
      onsetAt: new Date("2026-10-03T08:00:00.000Z"),
    });
    const ctx = await resolveRestMode(USER, NOW, getPrismaClient());
    expect(ctx.active).toBe(true);
    expect(ctx.since).toBe("2026-10-03T08:00:00.000Z");
  });
});

describe("the Today digest's Rest Mode fact", () => {
  const NOW = new Date("2026-10-04T06:00:00.000Z");

  async function digest() {
    const user = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: USER },
    });
    return loadDailyDigest(user, NOW, { locale: "en" });
  }

  it("shows no Rest Mode for a chronic condition alone", async () => {
    await episode({});
    const d = await digest();
    expect(d.restMode).toBeNull();
    expect(d.today.some((f) => f.kind === "rest_mode")).toBe(false);
  });

  it("counts Day N from the acute onset, not the chronic one", async () => {
    await episode({});
    await episode({
      label: "Cold",
      type: "INFECTION",
      lifecycle: "ACUTE",
      onsetAt: new Date("2026-10-02T18:00:00.000Z"),
    });
    const d = await digest();
    expect(d.restMode).toEqual({ day: 3 });
  });
});

describe("the achievements streak freeze", () => {
  const MODULES = {} as Record<ModuleKey, boolean>;

  /** Logins two days apart: a one-day gap the freeze may or may not bridge. */
  async function loginsAroundAGap() {
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    const gapDay = new Date(today.getTime() - 4 * DAY);
    await getPrismaClient().auditLog.createMany({
      data: [5, 3].map((d) => ({
        userId: USER,
        action: "auth.login.password",
        createdAt: new Date(today.getTime() - d * DAY),
      })),
    });
    return gapDay;
  }

  async function loginStreak() {
    const user = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: USER },
    });
    const result = await buildAchievementsResult(
      user as Parameters<typeof buildAchievementsResult>[0],
      MODULES,
    );
    return result.metrics.loginDayStreak;
  }

  it("does not bridge a gap on a chronic-only day", async () => {
    await loginsAroundAGap();
    await episode({});
    expect(await loginStreak()).toBe(1);
  });

  it("still bridges a gap covered by an acute episode", async () => {
    const gapDay = await loginsAroundAGap();
    await episode({});
    await episode({
      label: "Cold",
      type: "INFECTION",
      lifecycle: "ACUTE",
      onsetAt: new Date(gapDay.getTime() - 2 * 60 * 60 * 1000),
      resolvedAt: new Date(gapDay.getTime() + 6 * 60 * 60 * 1000),
    });
    expect(await loginStreak()).toBe(3);
  });
});
