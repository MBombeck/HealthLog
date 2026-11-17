/**
 * Who may call `POST /api/nutrients/batch`, and what a narrow
 * `measurements:write` credential writes, against the real database and
 * through the real API kit (#1402).
 *
 * Pinned here, read back from the stored rows:
 *   - a cookie session and a wildcard token write the APPLE_HEALTH row; a
 *     `measurements:write` token writes the EXTERNAL row, resolved from the
 *     credential; every other narrow token is 403 and writes nothing;
 *   - the module gate refuses the token like it refuses the phone;
 *   - a bridge re-post replaces its day in place, any past day is accepted,
 *     and its row coexists with the phone's for the same day;
 *   - a bridge counts in a rate-limit bucket of its own;
 *   - a supplement-only code is refused 422 for a bridge too.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { User } from "@/generated/prisma/client";
import { POST } from "@/app/api/nutrients/batch/route";
import { GET as GET_DAILY } from "@/app/api/nutrients/daily/route";
import { DOCUMENTS_WRITE_SCOPE } from "@/lib/documents/scopes";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";
import { WORKOUTS_WRITE_SCOPE } from "@/lib/workouts/scopes";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";

import { callRoute, type RouteAuth } from "../../kit/call-route";
import { makeSession, makeToken, makeUser } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const prisma = getPrismaClient();
const ROUTE = "/api/nutrients/batch";
const TZ = "Europe/Berlin";

interface BatchResult {
  processed: number;
  inserted: number;
  updated: number;
  skipped: Array<{ index: number; reason: string }>;
  entries: Array<{ index: number; status: string; reason?: string }>;
}

beforeEach(() => truncateAllTables(prisma));

/** A local day key `n` days back from the caller's today. */
function day(n: number): string {
  return shiftDateKey(userDayKey(new Date(), TZ), -n);
}

function nutrientUser(): Promise<User> {
  return makeUser({
    timezone: TZ,
    modulePreferencesJson: { nutrients: true },
  });
}

function post(entries: Array<Record<string, unknown>>, auth: RouteAuth) {
  return callRoute<BatchResult>(POST, {
    method: "POST",
    route: ROUTE,
    body: { entries },
    auth,
  });
}

const energy = (d: string, amount: number) => ({
  day: d,
  nutrient: "energy",
  unit: "kcal",
  amount,
});

async function rows(user: Pick<User, "id">) {
  return prisma.nutrientIntakeDay.findMany({
    where: { userId: user.id },
    orderBy: [{ day: "asc" }, { source: "asc" }],
    select: { day: true, nutrient: true, source: true, amount: true },
  });
}

function bridge(user: Pick<User, "id">) {
  return makeToken(user, { permissions: [MEASUREMENTS_WRITE_SCOPE] });
}

describe("POST /api/nutrients/batch: the credential picks the source", () => {
  it("stores a session's day total as APPLE_HEALTH", async () => {
    const user = await nutrientUser();
    const res = await post([energy(day(1), 2000)], await makeSession(user));
    expect(res.status).toBe(200);
    expect((await rows(user)).map((r) => r.source)).toEqual(["APPLE_HEALTH"]);
  });

  it("stores a wildcard token's day total as APPLE_HEALTH", async () => {
    const user = await nutrientUser();
    const res = await post([energy(day(1), 2000)], await makeToken(user));
    expect(res.status).toBe(200);
    expect((await rows(user)).map((r) => r.source)).toEqual(["APPLE_HEALTH"]);
  });

  it("stores a measurements:write token's day total as EXTERNAL", async () => {
    const user = await nutrientUser();
    const res = await post(
      [
        energy(day(1), 2100),
        { day: day(1), nutrient: "protein", unit: "g", amount: 95 },
        { day: day(1), nutrient: "alcohol", unit: "g", amount: 24 },
      ],
      await bridge(user),
    );
    expect(res.status).toBe(200);
    expect(res.data.inserted).toBe(3);
    const stored = await rows(user);
    expect(stored.every((r) => r.source === "EXTERNAL")).toBe(true);
    expect(stored.map((r) => r.nutrient).sort()).toEqual([
      "alcohol",
      "energy",
      "protein",
    ]);
  });

  it.each([
    ["workouts:write", [WORKOUTS_WRITE_SCOPE]],
    ["documents:write", [DOCUMENTS_WRITE_SCOPE]],
    ["health:read", ["health:read"]],
  ])("refuses a %s token with 403 and writes nothing", async (_, perms) => {
    const user = await nutrientUser();
    const res = await post(
      [energy(day(1), 2000)],
      await makeToken(user, { permissions: perms }),
    );
    expect(res.status).toBe(403);
    expect(res.meta?.errorCode).toBe("auth.scope.insufficient");
    expect(await rows(user)).toEqual([]);
  });

  it("refuses the token with module.disabled while the module is off", async () => {
    const user = await makeUser({ timezone: TZ });
    const res = await post([energy(day(1), 2000)], await bridge(user));
    expect(res.status).toBe(403);
    expect(res.meta?.errorCode).toBe("module.disabled");
    expect(await rows(user)).toEqual([]);
  });

  it("refuses a supplement-only code with 422", async () => {
    const user = await nutrientUser();
    const res = await post(
      [{ day: day(1), nutrient: "dha", unit: "mg", amount: 250 }],
      await bridge(user),
    );
    expect(res.status).toBe(422);
    expect(await rows(user)).toEqual([]);
  });
});

describe("POST /api/nutrients/batch: a bridge's day totals", () => {
  it("replaces its day in place on a re-post, and a 0 corrects it", async () => {
    const user = await nutrientUser();
    const token = await bridge(user);
    await post([energy(day(2), 2400)], token);
    const again = await post([energy(day(2), 0)], token);
    expect(again.data.entries).toEqual([{ index: 0, status: "updated" }]);
    expect(await rows(user)).toEqual([
      { day: day(2), nutrient: "energy", source: "EXTERNAL", amount: 0 },
    ]);
  });

  it("accepts a day from long ago, so a bridge can backfill its history", async () => {
    const user = await nutrientUser();
    const res = await post([energy(day(400), 1900)], await bridge(user));
    expect(res.data.inserted).toBe(1);
  });

  it("coexists with the phone's row for the same day, and the read counts the larger", async () => {
    const user = await nutrientUser();
    const session = await makeSession(user);
    await post([energy(day(0), 2000)], session);
    await post([energy(day(0), 2100)], await bridge(user));
    expect((await rows(user)).map((r) => [r.source, r.amount])).toEqual([
      ["APPLE_HEALTH", 2000],
      ["EXTERNAL", 2100],
    ]);

    const daily = await callRoute<{
      days: Array<{ day: string; amount: number; bySource?: object }>;
    }>(GET_DAILY, {
      method: "GET",
      route: "/api/nutrients/daily",
      query: { nutrient: "energy", days: 3 },
      auth: session,
    });
    const today = daily.data.days.at(-1);
    expect(today?.day).toBe(day(0));
    expect(today?.amount).toBe(2100);
    expect(today?.bySource).toEqual({ EXTERNAL: 2100 });
  });

  it("counts in a rate-limit bucket of its own", async () => {
    const user = await nutrientUser();
    await post([energy(day(1), 2000)], await makeSession(user));
    await post([energy(day(1), 2100)], await bridge(user));
    const keys = (
      await prisma.rateLimit.findMany({
        where: { key: { startsWith: "nutrients:batch" } },
        select: { key: true },
      })
    )
      .map((r) => r.key)
      .sort();
    expect(keys).toEqual(
      [
        `nutrients:batch:${user.id}`,
        `nutrients:batch:bridge:${user.id}`,
      ].sort(),
    );
  });
});
