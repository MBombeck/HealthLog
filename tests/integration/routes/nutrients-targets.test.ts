/**
 * `GET` / `PATCH /api/nutrients/targets` and the target the daily series
 * carries, against the real database and through the real API kit (#1402).
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { User } from "@/generated/prisma/client";
import { GET, PATCH } from "@/app/api/nutrients/targets/route";
import { GET as GET_DAILY } from "@/app/api/nutrients/daily/route";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";

import { callRoute, type RouteAuth } from "../../kit/call-route";
import { makeSession, makeToken, makeUser } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const prisma = getPrismaClient();
const ROUTE = "/api/nutrients/targets";

type Targets = Record<string, { value: number; direction: string }>;

beforeEach(() => truncateAllTables(prisma));

function nutrientUser(): Promise<User> {
  return makeUser({ modulePreferencesJson: { nutrients: true } });
}

function patch(targets: Record<string, unknown>, auth: RouteAuth) {
  return callRoute<{ targets: Targets }>(PATCH, {
    method: "PATCH",
    route: ROUTE,
    body: { targets },
    auth,
  });
}

async function stored(user: Pick<User, "id">) {
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { nutrientTargetsJson: true },
  });
  return row?.nutrientTargetsJson ?? null;
}

describe("/api/nutrients/targets", () => {
  it("sets, merges and clears targets code by code", async () => {
    const user = await nutrientUser();
    const session = await makeSession(user);

    const first = await patch(
      {
        protein: { value: 120, direction: "target" },
        sugar: { value: 40, direction: "limit" },
      },
      session,
    );
    expect(first.status).toBe(200);

    const second = await patch(
      { sugar: null, energy: { value: 2200, direction: "target" } },
      session,
    );
    expect(second.data.targets).toEqual({
      energy: { value: 2200, direction: "target" },
      protein: { value: 120, direction: "target" },
    });
    expect(await stored(user)).toEqual(second.data.targets);

    const read = await callRoute<{ targets: Targets }>(GET, {
      method: "GET",
      route: ROUTE,
      auth: session,
    });
    expect(read.data.targets).toEqual(second.data.targets);

    await patch({ energy: null, protein: null }, session);
    expect(await stored(user)).toBeNull();
  });

  it("refuses an unknown code or an out-of-range value with 422 and stores nothing", async () => {
    const user = await nutrientUser();
    const session = await makeSession(user);
    for (const targets of [
      { creatine: { value: 5, direction: "target" } },
      { protein: { value: 5000, direction: "target" } },
    ]) {
      const res = await patch(targets, session);
      expect(res.status, JSON.stringify(targets)).toBe(422);
    }
    expect(await stored(user)).toBeNull();
  });

  it("refuses with module.disabled while the module is off", async () => {
    const user = await makeUser();
    const res = await patch(
      { protein: { value: 120, direction: "target" } },
      await makeSession(user),
    );
    expect(res.status).toBe(403);
    expect(res.meta?.errorCode).toBe("module.disabled");
  });

  it("refuses a measurements:write token: a bridge cannot set targets", async () => {
    const user = await nutrientUser();
    const res = await patch(
      { protein: { value: 120, direction: "target" } },
      await makeToken(user, { permissions: [MEASUREMENTS_WRITE_SCOPE] }),
    );
    expect(res.status).toBe(403);
    expect(await stored(user)).toBeNull();
  });

  it("returns the code's target on the daily series, and null for a code without one", async () => {
    const user = await nutrientUser();
    const session = await makeSession(user);
    await patch({ protein: { value: 120, direction: "target" } }, session);

    const daily = (nutrient: string) =>
      callRoute<{ personalTarget: unknown }>(GET_DAILY, {
        method: "GET",
        route: "/api/nutrients/daily",
        query: { nutrient, days: 7 },
        auth: session,
      });
    expect((await daily("protein")).data.personalTarget).toEqual({
      value: 120,
      direction: "target",
    });
    expect((await daily("water")).data.personalTarget).toBeNull();
  });
});
