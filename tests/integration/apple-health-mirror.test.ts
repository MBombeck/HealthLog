/**
 * Per-token Apple Health write-back (#1272), end to end against Postgres.
 *
 * A reading a `measurements:write` token carries keeps its `EXTERNAL` source
 * and is linked to the token. Every measurement row answers a resolved
 * `appleHealthMirror`: WITHINGS, IMPORT and MANUAL true, EXTERNAL whatever the
 * person chose for the token, everything else false. Switching the setting is
 * one statement on the token row: the readings themselves are not touched
 * (no `updatedAt` or `syncVersion` bump, so nothing keyed on them recomputes),
 * and the `measurementMirror` domain of `/api/sync/changes` re-delivers the
 * token's rows with the new value.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  GET as listMeasurements,
  POST as createMeasurement,
} from "@/app/api/measurements/route";
import { POST as batchMeasurements } from "@/app/api/measurements/batch/route";
import { GET as readMeasurement } from "@/app/api/measurements/[id]/route";
import { GET as syncChanges } from "@/app/api/sync/changes/route";
import {
  PATCH as patchToken,
  DELETE as revokeToken,
} from "@/app/api/tokens/[id]/route";
import { GET as listTokens } from "@/app/api/tokens/route";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";
import { MEASUREMENT_SOURCES } from "@/lib/measurements/sources";

import { callRoute, type RouteAuth } from "../kit/call-route";
import {
  makeMeasurement,
  makeSession,
  makeToken,
  makeUser,
  type BearerFixture,
} from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

let userId: string;
let owner: RouteAuth;
let scale: BearerFixture;

beforeEach(async () => {
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "UTC" });
  userId = user.id;
  owner = await makeSession(user);
  scale = await makeToken(user, {
    permissions: [MEASUREMENTS_WRITE_SCOPE],
    name: "Scale",
  });
});

async function postReading(
  value: number,
  at: string,
  headers?: Record<string, string>,
) {
  return callRoute<{ id: string }>(createMeasurement, {
    method: "POST",
    route: "/api/measurements",
    body: { type: "WEIGHT", value, unit: "kg", measuredAt: at },
    auth: scale,
    headers,
  });
}

async function list(query: Record<string, string | number> = {}) {
  const res = await callRoute<{
    measurements: Array<{
      id: string;
      source: string;
      appleHealthMirror: boolean;
    }>;
  }>(listMeasurements, {
    method: "GET",
    route: "/api/measurements",
    query: { limit: 50, ...query },
    auth: owner,
  });
  expect(res.status).toBe(200);
  return res.data.measurements;
}

async function setMirror(id: string, on: boolean, auth: RouteAuth = owner) {
  return callRoute<{ id: string; mirrorToAppleHealth: boolean }>(patchToken, {
    method: "PATCH",
    route: "/api/tokens/{id}",
    params: { id },
    body: { mirrorToAppleHealth: on },
    auth,
  });
}

describe("a token's readings and the resolved write-back", () => {
  it("links the reading to its token and resolves each source", async () => {
    const res = await postReading(81.2, "2026-10-14T06:30:00.000Z");
    expect(res.status).toBe(201);
    const stored = await prisma.measurement.findFirstOrThrow({
      where: { userId, source: "EXTERNAL" },
      select: { ingestTokenId: true },
    });
    expect(stored.ingestTokenId).toBe(scale.tokenId);

    await makeMeasurement(
      { id: userId },
      {
        source: "MANUAL",
        measuredAt: new Date("2026-10-13T06:30:00.000Z"),
      },
    );
    await makeMeasurement(
      { id: userId },
      {
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-10-12T06:30:00.000Z"),
        externalId: "hk-1",
      },
    );

    const rows = await list({ type: "WEIGHT" });
    const bySource = Object.fromEntries(
      rows.map((r) => [r.source, r.appleHealthMirror]),
    );
    expect(bySource).toEqual({
      EXTERNAL: false,
      MANUAL: true,
      APPLE_HEALTH: false,
    });
    // The token never reaches the wire.
    for (const row of rows) {
      expect(row).not.toHaveProperty("ingestTokenId");
      expect(row).not.toHaveProperty("ingestToken");
    }
  });

  it("links every row of a token batch", async () => {
    const res = await callRoute(batchMeasurements, {
      method: "POST",
      route: "/api/measurements/batch",
      body: {
        entries: [
          {
            hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
            value: 80.1,
            unit: "kg",
            startDate: "2026-10-14T06:30:00.000Z",
            endDate: "2026-10-14T06:30:00.000Z",
            externalId: "scale-1",
          },
        ],
      },
      auth: scale,
    });
    expect(res.status).toBe(200);
    const rows = await prisma.measurement.findMany({
      where: { userId },
      select: { source: true, ingestTokenId: true },
    });
    expect(rows).toEqual([
      { source: "EXTERNAL", ingestTokenId: scale.tokenId },
    ]);
  });
});

describe("the list filter", () => {
  it("returns exactly the rows that resolve true, for every source", async () => {
    const on = await makeToken(
      { id: userId },
      { permissions: [MEASUREMENTS_WRITE_SCOPE], name: "On" },
    );
    await prisma.apiToken.update({
      where: { id: on.tokenId },
      data: { mirrorToAppleHealth: true },
    });
    let minute = 0;
    for (const source of MEASUREMENT_SOURCES) {
      for (const ingestTokenId of [null, scale.tokenId, on.tokenId]) {
        minute += 1;
        await makeMeasurement(
          { id: userId },
          {
            source,
            ingestTokenId,
            measuredAt: new Date(Date.UTC(2026, 9, 1, 6, minute)),
            externalId: `row-${minute}`,
          },
        );
      }
    }
    const all = await list({ limit: 500 });
    expect(all).toHaveLength(MEASUREMENT_SOURCES.length * 3);
    const expected = all
      .filter((r) => r.appleHealthMirror)
      .map((r) => r.id)
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    const filtered = await list({ limit: 500, appleHealthMirror: "true" });
    expect(filtered.map((r) => r.id).sort()).toEqual(expected);
  });

  it.each([
    { groupBy: "day" },
    { dayKey: "2026-10-14" },
    { aggregate: "daily" },
    { type: "SLEEP_DURATION" },
  ])("is refused beside %j", async (mode) => {
    const res = await callRoute(listMeasurements, {
      method: "GET",
      route: "/api/measurements",
      query: { type: "WEIGHT", ...mode, appleHealthMirror: "true" },
      auth: owner,
    });
    expect(res.status).toBe(422);
  });
});

describe("switching the setting", () => {
  it("turns the token's rows true everywhere, and leaves the rows themselves alone", async () => {
    const created = await postReading(81.2, "2026-10-14T06:30:00.000Z");
    const id = created.data.id;
    const before = await prisma.measurement.findUniqueOrThrow({
      where: { id },
      select: { updatedAt: true, syncVersion: true },
    });
    const first = await callRoute<{ cursor: string }>(syncChanges, {
      method: "GET",
      route: "/api/sync/changes",
      auth: owner,
    });

    const res = await setMirror(scale.tokenId, true);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: scale.tokenId, mirrorToAppleHealth: true });

    const after = await prisma.measurement.findUniqueOrThrow({
      where: { id },
      select: { updatedAt: true, syncVersion: true },
    });
    expect(after).toEqual(before);

    expect((await list())[0].appleHealthMirror).toBe(true);
    expect(
      (await list({ appleHealthMirror: "true" })).map((r) => r.id),
    ).toEqual([id]);
    const detail = await callRoute<{ appleHealthMirror: boolean }>(
      readMeasurement,
      {
        method: "GET",
        route: "/api/measurements/{id}",
        params: { id },
        auth: owner,
      },
    );
    expect(detail.data.appleHealthMirror).toBe(true);

    const next = await callRoute<{
      changes: {
        measurements: { upserts: unknown[] };
        measurementMirror: {
          upserts: Array<{ id: string; appleHealthMirror: boolean }>;
        };
      };
    }>(syncChanges, {
      method: "GET",
      route: "/api/sync/changes",
      query: { cursor: first.data.cursor },
      auth: owner,
    });
    expect(next.data.changes.measurements.upserts).toEqual([]);
    expect(next.data.changes.measurementMirror.upserts).toEqual([
      { id, appleHealthMirror: true },
    ]);

    const audit = await prisma.auditLog.findMany({
      where: { userId, action: "tokens.measurements.mirror.update" },
      select: { details: true },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].details ?? "{}")).toMatchObject({
      tokenId: scale.tokenId,
      mirrorToAppleHealth: true,
    });
  });

  it("keeps a revoked token's choice, and shows it on the token list", async () => {
    await postReading(81.2, "2026-10-14T06:30:00.000Z");
    await setMirror(scale.tokenId, true);
    const revoked = await callRoute(revokeToken, {
      method: "DELETE",
      route: "/api/tokens/{id}",
      params: { id: scale.tokenId },
      auth: owner,
    });
    expect(revoked.status).toBe(200);
    expect((await list())[0].appleHealthMirror).toBe(true);

    // A revoked token can still be switched.
    expect((await setMirror(scale.tokenId, false)).status).toBe(200);
    expect((await list())[0].appleHealthMirror).toBe(false);

    const tokens = await callRoute<
      Array<{ id: string; mirrorToAppleHealth: boolean }>
    >(listTokens, { method: "GET", route: "/api/tokens", auth: owner });
    expect(tokens.data.find((t) => t.id === scale.tokenId)).toMatchObject({
      mirrorToAppleHealth: false,
    });
  });

  it("answers a retried create from its idempotency record, unchanged", async () => {
    const headers = { "idempotency-key": "scale-reading-1" };
    const first = await postReading(81.2, "2026-10-14T06:30:00.000Z", headers);
    await setMirror(scale.tokenId, true);
    const replay = await postReading(81.2, "2026-10-14T06:30:00.000Z", headers);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body);
    expect(
      await prisma.measurement.count({ where: { userId, source: "EXTERNAL" } }),
    ).toBe(1);
  });
});

describe("what the switch refuses", () => {
  it("refuses a token that is not a measurement token", async () => {
    const wildcard = await makeToken({ id: userId }, { permissions: ["*"] });
    const res = await setMirror(wildcard.tokenId, true);
    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("tokens.mirror.not_measurement_token");
  });

  it("answers another account's token as missing", async () => {
    const stranger = await makeUser({ timezone: "UTC" });
    const theirs = await makeToken(stranger, {
      permissions: [MEASUREMENTS_WRITE_SCOPE],
    });
    expect((await setMirror(theirs.tokenId, true)).status).toBe(404);
  });

  it("refuses a Bearer caller, the token's own included", async () => {
    const res = await setMirror(scale.tokenId, true, scale);
    expect([401, 403]).toContain(res.status);
    const stored = await prisma.apiToken.findUniqueOrThrow({
      where: { id: scale.tokenId },
      select: { mirrorToAppleHealth: true },
    });
    expect(stored.mirrorToAppleHealth).toBe(false);
  });
});
