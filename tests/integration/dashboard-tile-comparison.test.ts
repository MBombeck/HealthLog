/**
 * The dashboard snapshot serves where a tile's 7- and 30-day means sit
 * against the target band, and the deviation line, through the real route
 * against Postgres: a person 178 cm tall whose weight sits far above the
 * height-derived band reads `low` / `above` on the weight tile and the line in
 * their own language, and a tile with no band (body fat) is absent.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

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

const prisma = getPrismaClient();
const USER = "tile-comparison";

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: "Europe/Berlin",
      locale: "de",
      dateOfBirth: new Date("1970-03-01T00:00:00.000Z"),
      gender: "MALE",
      heightCm: 178,
    },
  });
  invalidateUserTimezone(USER);
  const now = Date.now();
  const rows = Array.from({ length: 10 }, (_, i) => i);
  await prisma.measurement.createMany({
    data: [
      ...rows.map((i) => ({
        id: `${USER}-w-${i}`,
        userId: USER,
        type: "WEIGHT" as const,
        unit: "kg",
        source: "MANUAL" as const,
        value: 120,
        measuredAt: new Date(now - (i * 86_400_000 + 3_600_000)),
      })),
      ...rows.map((i) => ({
        id: `${USER}-f-${i}`,
        userId: USER,
        type: "BODY_FAT" as const,
        unit: "%",
        source: "MANUAL" as const,
        value: 30,
        measuredAt: new Date(now - (i * 86_400_000 + 3_600_000)),
      })),
    ],
  });
  const session = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 60 * 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}, 120_000);

describe("tiles.comparison on the dashboard snapshot (real Postgres)", () => {
  it("places the weight means above the band and words the line", async () => {
    const { GET } = await import("@/app/api/dashboard/snapshot/route");
    const res = await GET(
      new Request("http://localhost/api/dashboard/snapshot"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        tiles: {
          attention?: Record<string, string>;
          comparison?: Record<
            string,
            {
              avg7: { band: string | null; side: string | null };
              avg30: { band: string | null; side: string | null };
              line: string | null;
            }
          >;
        };
      };
    };
    const { attention, comparison } = body.data.tiles;
    expect(attention?.weight).toBe("range");
    expect(comparison?.weight).toEqual({
      avg7: { band: "low", side: "above" },
      avg30: { band: "low", side: "above" },
      line: "Über dem Zielbereich",
    });
    expect(comparison?.bodyFat).toBeUndefined();
  });
});
