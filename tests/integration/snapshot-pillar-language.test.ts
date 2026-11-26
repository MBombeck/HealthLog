/**
 * The health score's pillar rows on the dashboard snapshot are worded in the
 * app's language. The app reads them from the snapshot and shows them as
 * they come, so an account stored as English, read by an app running in
 * German, must get German pillar names and reasons.
 *
 * Real Postgres, real route, an app token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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

import { hashToken } from "@/lib/auth/hmac";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  const { __resetAllCachesForTests } = await import("@/lib/cache/server-cache");
  __resetAllCachesForTests();
});

/** An English account with a scored day, signed in with an app token. */
async function scoredAppAccount() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "pillar-language",
      email: "pillar-language@example.test",
      role: "USER",
      locale: "en",
      heightCm: 178,
      dateOfBirth: new Date("1985-07-09"),
    },
  });
  const raw = "hlk_pillar-language".padEnd(24, "0");
  await prisma.apiToken.create({
    data: {
      userId: user.id,
      name: "app",
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
  });
  headerJar.set("authorization", `Bearer ${raw}`);

  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const at = new Date(now - i * DAY);
    rows.push(
      {
        type: "BLOOD_PRESSURE_SYS" as const,
        value: 122,
        unit: "mmHg",
        measuredAt: at,
      },
      {
        type: "BLOOD_PRESSURE_DIA" as const,
        value: 78,
        unit: "mmHg",
        measuredAt: at,
      },
    );
  }
  for (let i = 0; i < 14; i++) {
    const wake = new Date(now - i * DAY);
    wake.setUTCHours(6, 0, 0, 0);
    rows.push({
      type: "SLEEP_DURATION" as const,
      value: 450,
      unit: "min",
      measuredAt: wake,
      sleepStage: "ASLEEP" as const,
    });
  }
  rows.push({
    type: "WAIST_CIRCUMFERENCE" as const,
    value: 82,
    unit: "cm",
    measuredAt: new Date(now),
  });
  await prisma.measurement.createMany({
    data: rows.map((row) => ({ ...row, userId: user.id })),
  });
  await recomputeUserRollups(user.id);
  return user;
}

async function pillars(acceptLanguage: string) {
  headerJar.set("accept-language", acceptLanguage);
  const { GET } = await import("@/app/api/dashboard/snapshot/route");
  const res = await GET(
    new NextRequest("http://localhost/api/dashboard/snapshot", {
      headers: {
        authorization: headerJar.get("authorization") ?? "",
        "accept-language": acceptLanguage,
      },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: {
      healthScore: {
        pillars: Array<{ id: string; label: string; reason: string | null }>;
      } | null;
    };
  };
  expect(body.data.healthScore).not.toBeNull();
  return body.data.healthScore!.pillars;
}

describe("health score pillars on a Bearer snapshot read", () => {
  it("names the pillars in the app's language, not the stored one", async () => {
    await scoredAppAccount();

    const de = await pillars("de-DE");
    expect(de.find((p) => p.id === "BLOOD_PRESSURE")?.label).toBe("Blutdruck");
    // An unscored pillar's reason is worded too, never a raw code.
    const unscored = de.find((p) => p.reason !== null);
    expect(unscored?.reason).toBeTruthy();
    expect(unscored?.reason).not.toMatch(/^[a-z_]+$/);

    const en = await pillars("en-US");
    expect(en.find((p) => p.id === "BLOOD_PRESSURE")?.label).toBe(
      "Blood pressure",
    );
    expect(unscored && en.find((p) => p.id === unscored.id)?.reason).not.toBe(
      unscored?.reason,
    );
  });
});
