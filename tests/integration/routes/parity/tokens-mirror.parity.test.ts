/**
 * Parity for the Apple Health write-back of measurement tokens (#1272):
 * `PATCH /api/tokens/{id}`, the summary `GET /api/tokens/measurements` and
 * the token list that carries the setting.
 *
 * One account walks through the cases the routes tell apart, in order: the
 * summary with readings no token reaches, the switch turned on, the same
 * value again (nothing written, nothing audited), turned off on a revoked
 * token, a wildcard and an MCP token refused, another account's token, an
 * unknown id, bodies the schema refuses, and a Bearer caller. After each
 * request the snapshot holds the response, the wide event, the token rows,
 * the audit rows and the readings' stamps, which must never move.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PATCH, DELETE as revoke } from "@/app/api/tokens/[id]/route";
import { GET as listTokens } from "@/app/api/tokens/route";
import { GET as summary } from "@/app/api/tokens/measurements/route";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";

import { callRoute, type RouteAuth } from "../../../kit/call-route";
import {
  makeMeasurement,
  makeSession,
  makeToken,
  makeUser,
  type BearerFixture,
} from "../../../kit/factories";
import {
  eventFacts,
  expectParity,
  stable,
  wideEventRecorder,
} from "../../../kit/parity";
import { getPrismaClient, truncateAllTables } from "../../setup";

vi.mock("@/lib/logging/transports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/logging/transports")>();
  const { wideEventRecorder: recorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitIfSampled: (event: (typeof recorder.events)[number]) => {
      recorder.events.push(event);
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");

let userId: string;
let owner: RouteAuth;
let scale: BearerFixture;
let wildcard: BearerFixture;
let connector: BearerFixture;
let theirs: BearerFixture;

async function stored() {
  const [tokens, audit, readings] = await Promise.all([
    prisma.apiToken.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: {
        name: true,
        permissions: true,
        revoked: true,
        mirrorToAppleHealth: true,
        mirrorChangedAt: true,
      },
    }),
    prisma.auditLog.findMany({
      where: { userId, action: { startsWith: "tokens." } },
      orderBy: { createdAt: "asc" },
      select: { action: true, details: true },
    }),
    prisma.measurement.findMany({
      where: { userId },
      orderBy: { measuredAt: "asc" },
      select: {
        source: true,
        ingestTokenId: true,
        updatedAt: true,
        syncVersion: true,
      },
    }),
  ]);
  // Renamed so the snapshot keeps the values (`updatedAt` and `syncVersion`
  // are blanked as volatile): a switch must never move them.
  return {
    tokens,
    // Parsed, so the token id inside reads as its placeholder.
    audit: audit.map((a) => ({
      action: a.action,
      details: a.details ? JSON.parse(a.details) : null,
    })),
    readings: readings.map((r) => ({
      source: r.source,
      ingestTokenId: r.ingestTokenId,
      stamp: r.updatedAt.toISOString(),
      version: r.syncVersion,
    })),
  };
}

async function step(
  name: string,
  call:
    | { kind: "patch"; id: string; body: unknown; auth?: RouteAuth }
    | { kind: "summary" | "list"; auth?: RouteAuth },
): Promise<void> {
  wideEventRecorder.take();
  const res =
    call.kind === "patch"
      ? await callRoute(PATCH, {
          method: "PATCH",
          route: "/api/tokens/{id}",
          params: { id: call.id },
          body: call.body,
          auth: call.auth ?? owner,
        })
      : await callRoute(call.kind === "summary" ? summary : listTokens, {
          method: "GET",
          route:
            call.kind === "summary"
              ? "/api/tokens/measurements"
              : "/api/tokens",
          auth: call.auth ?? owner,
        });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `tokens-mirror.${name}`,
    stable(
      {
        status: res.status,
        body: res.body,
        events: events.map(eventFacts),
        stored: await stored(),
      },
      { since: NOW, volatileKeys: ["mirrorChangedAt"] },
    ),
  );
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "UTC" });
  userId = user.id;
  owner = await makeSession(user);
  scale = await makeToken(user, {
    permissions: [MEASUREMENTS_WRITE_SCOPE],
    name: "Scale",
  });
  wildcard = await makeToken(user, { permissions: ["*"], name: "Phone" });
  connector = await makeToken(user, {
    permissions: ["health:read"],
    name: "Connector",
  });
  theirs = await makeToken(await makeUser({ timezone: "UTC" }), {
    permissions: [MEASUREMENTS_WRITE_SCOPE],
    name: "Theirs",
  });
  const stamp = new Date("2026-10-10T08:00:00.000Z");
  await makeMeasurement(user, {
    source: "EXTERNAL",
    ingestTokenId: scale.tokenId,
    measuredAt: new Date("2026-10-10T07:00:00.000Z"),
    updatedAt: stamp,
  });
  await makeMeasurement(user, {
    source: "EXTERNAL",
    measuredAt: new Date("2026-10-09T07:00:00.000Z"),
    updatedAt: stamp,
  });
});

describe("the Apple Health write-back of a measurement token", () => {
  it("walks the cases in order", async () => {
    await step("01-summary", { kind: "summary" });
    await step("02-on", {
      kind: "patch",
      id: scale.tokenId,
      body: { mirrorToAppleHealth: true },
    });
    await step("03-on-again", {
      kind: "patch",
      id: scale.tokenId,
      body: { mirrorToAppleHealth: true },
    });
    await step("04-list", { kind: "list" });
    const revoked = await callRoute(revoke, {
      method: "DELETE",
      route: "/api/tokens/{id}",
      params: { id: scale.tokenId },
      auth: owner,
    });
    expect(revoked.status).toBe(200);
    await step("05-off-revoked", {
      kind: "patch",
      id: scale.tokenId,
      body: { mirrorToAppleHealth: false },
    });
    await step("06-wildcard", {
      kind: "patch",
      id: wildcard.tokenId,
      body: { mirrorToAppleHealth: true },
    });
    await step("07-connector", {
      kind: "patch",
      id: connector.tokenId,
      body: { mirrorToAppleHealth: true },
    });
    await step("08-another-account", {
      kind: "patch",
      id: theirs.tokenId,
      body: { mirrorToAppleHealth: true },
    });
    await step("09-unknown", {
      kind: "patch",
      id: "missing-token",
      body: { mirrorToAppleHealth: true },
    });
    await step("10-invalid-body", {
      kind: "patch",
      id: scale.tokenId,
      body: { mirrorToAppleHealth: "yes", name: "Renamed" },
    });
    await step("11-bearer", {
      kind: "patch",
      id: scale.tokenId,
      body: { mirrorToAppleHealth: true },
      auth: wildcard,
    });
    await step("12-summary-bearer", { kind: "summary", auth: wildcard });
  });
});
