/**
 * Integration guard: nutrient day totals ride the full backup.
 *
 * `NutrientIntakeDay` was in no export path at all — which contradicted the
 * schema's own justification for denormalising the `unit` column ("rows stay
 * self-describing in exports even if the catalog ever drifts"). A user who
 * exported everything still lost every water and micronutrient row.
 *
 * `source` is part of the composite primary key, so it has to ride along too:
 * without it a restore cannot tell a manual water entry from a synced day
 * total, and the two collapse onto one row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedUserSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: { username, email: `${username}@example.test`, role: "USER" },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

interface BackupWithNutrients {
  userId: string;
  nutrientDays?: Array<{
    day: string;
    nutrient: string;
    amount: number;
    unit: string;
    source: string;
  }>;
}

describe("full backup — nutrient day totals", () => {
  it("exports nutrient rows for the authed user, keeping unit and source", async () => {
    const prisma = getPrismaClient();
    const me = await seedUserSession("nutrient-backup-user");
    const other = await prisma.user.create({
      data: {
        username: "nutrient-other",
        email: "nutrient-other@example.test",
        role: "USER",
      },
    });

    await prisma.nutrientIntakeDay.createMany({
      data: [
        {
          userId: me.id,
          day: "2026-05-01",
          nutrient: "water",
          amount: 1500,
          unit: "ml",
          source: "MANUAL",
        },
        // Same (day, nutrient) under the other source — both must survive,
        // which is the whole reason `source` joined the composite PK.
        {
          userId: me.id,
          day: "2026-05-01",
          nutrient: "water",
          amount: 800,
          unit: "ml",
          source: "APPLE_HEALTH",
        },
        {
          userId: me.id,
          day: "2026-05-01",
          nutrient: "vitamin_d",
          amount: 12.5,
          unit: "ug",
          source: "APPLE_HEALTH",
        },
        {
          userId: other.id,
          day: "2026-05-01",
          nutrient: "water",
          amount: 9999,
          unit: "ml",
          source: "MANUAL",
        },
      ],
    });

    const { GET } = await import("@/app/api/export/full-backup/route");
    const res = await GET(
      new Request("http://localhost/api/export/full-backup", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(200);

    const parsed = JSON.parse(await res.text()) as BackupWithNutrients;
    expect(parsed.userId).toBe(me.id);

    const rows = parsed.nutrientDays ?? [];
    expect(rows).toHaveLength(3);

    // No cross-tenant leak.
    expect(rows.some((r) => r.amount === 9999)).toBe(false);

    // Both source rows for the same (day, nutrient) survive independently.
    const water = rows.filter((r) => r.nutrient === "water");
    expect(water).toHaveLength(2);
    expect(water.map((r) => r.source).sort()).toEqual([
      "APPLE_HEALTH",
      "MANUAL",
    ]);

    // The denormalised unit rides along, per the schema's own contract.
    const vitaminD = rows.find((r) => r.nutrient === "vitamin_d");
    expect(vitaminD).toMatchObject({ unit: "ug", amount: 12.5 });
  });

  it("emits an empty array, not a missing key, for an account with no nutrient rows", async () => {
    await seedUserSession("nutrient-empty-user");

    const { GET } = await import("@/app/api/export/full-backup/route");
    const res = await GET(
      new Request("http://localhost/api/export/full-backup", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(200);

    const parsed = JSON.parse(await res.text()) as BackupWithNutrients;
    expect(parsed.nutrientDays).toEqual([]);
  });
});
