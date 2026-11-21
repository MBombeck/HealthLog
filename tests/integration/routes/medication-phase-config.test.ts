/**
 * `/api/medications/{id}/phase-config` — read, replace and reset a
 * medication's reminder phase configuration, against the real database and
 * through the real API kit.
 *
 * Pinned here:
 *   - with no stored row the GET answers the defaults, which carry no `id`
 *     and no `medicationId`;
 *   - the PUT stores exactly the eight phase fields (an unknown body field
 *     is dropped, not written), replaces a stored row on a second write, and
 *     answers a malformed body with the multi-issue 422 while storing
 *     nothing;
 *   - the DELETE drops the row so the GET falls back to the defaults, and a
 *     second reset succeeds the same way;
 *   - another account's medication answers 404 on every verb and its row
 *     stays as it was; an anonymous caller is 401.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  DELETE,
  GET,
  PUT,
} from "@/app/api/medications/[id]/phase-config/route";

import { anonymous, callRoute } from "../../kit/call-route";
import { makeMedication, makeSession, makeUser } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";
import { expectSanitisedIssue } from "../zod-issue-shape";

const prisma = getPrismaClient();
const ROUTE = "/api/medications/{id}/phase-config";

const DEFAULTS = {
  greenValue: 60,
  greenMode: "MINUTES",
  yellowValue: 30,
  yellowMode: "MINUTES",
  orangeValue: 0,
  orangeMode: "MINUTES",
  redValue: 240,
  redMode: "MINUTES",
};

const CUSTOM = {
  greenValue: 45,
  greenMode: "PERCENT",
  yellowValue: 20,
  yellowMode: "MINUTES",
  orangeValue: 10,
  orangeMode: "PERCENT",
  redValue: 600,
  redMode: "MINUTES",
} as const;

type PhaseConfig = typeof DEFAULTS & { id?: string; medicationId?: string };

interface ValidationBody {
  data: null;
  error: string;
  details: { issues: Array<Record<string, unknown>> };
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

async function storedRow(medicationId: string) {
  return prisma.reminderPhaseConfig.findUnique({
    where: { medicationId },
    select: {
      greenValue: true,
      greenMode: true,
      yellowValue: true,
      yellowMode: true,
      orangeValue: true,
      orangeMode: true,
      redValue: true,
      redMode: true,
    },
  });
}

describe("GET /api/medications/{id}/phase-config", () => {
  it("answers the defaults, without an id, when nothing is stored", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);

    const res = await callRoute<PhaseConfig>(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual(DEFAULTS);
    expect(await storedRow(med.id)).toBeNull();
  });

  it("answers 401 to an anonymous caller", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);

    const res = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      auth: anonymous,
    });

    expect(res.status).toBe(401);
  });
});

describe("PUT /api/medications/{id}/phase-config", () => {
  it("stores the eight phase fields, drops an unknown one, and the GET reads them back", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);
    const session = await makeSession(owner);

    const res = await callRoute<PhaseConfig>(PUT, {
      method: "PUT",
      route: ROUTE,
      params: { id: med.id },
      body: { ...CUSTOM, maliciousField: "owned", medicationId: "elsewhere" },
      auth: session,
    });

    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ...CUSTOM, medicationId: med.id });
    expect(typeof res.data.id).toBe("string");
    expect(await storedRow(med.id)).toEqual(CUSTOM);
    expect(await prisma.reminderPhaseConfig.count()).toBe(1);

    const read = await callRoute<PhaseConfig>(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      auth: session,
    });
    expect(read.status).toBe(200);
    expect(read.data).toMatchObject({ ...CUSTOM, id: res.data.id });
  });

  it("replaces a stored configuration on a second write, keeping one row", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);
    const session = await makeSession(owner);
    await prisma.reminderPhaseConfig.create({
      data: { medicationId: med.id, ...CUSTOM },
    });

    const res = await callRoute<PhaseConfig>(PUT, {
      method: "PUT",
      route: ROUTE,
      params: { id: med.id },
      body: { ...DEFAULTS, redValue: 90 },
      auth: session,
    });

    expect(res.status).toBe(200);
    expect(await storedRow(med.id)).toEqual({ ...DEFAULTS, redValue: 90 });
    expect(await prisma.reminderPhaseConfig.count()).toBe(1);
  });

  it("answers a malformed body with every issue and stores nothing", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);

    const res = await callRoute(PUT, {
      method: "PUT",
      route: ROUTE,
      params: { id: med.id },
      body: {
        ...DEFAULTS,
        greenValue: "not-a-number",
        greenMode: "BOGUS",
        redValue: 10_000,
      },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(422);
    const body = res.body as ValidationBody;
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.map((i) => i.path).sort()).toEqual([
      "greenMode",
      "greenValue",
      "redValue",
    ]);
    for (const issue of body.details.issues) expectSanitisedIssue(issue);
    // The bounded field names both declared ends, never the value sent.
    expect(
      body.details.issues.find((i) => i.path === "redValue"),
    ).toMatchObject({
      code: "too_big",
      minimum: 0,
      maximum: 1440,
      minimumInclusive: true,
      maximumInclusive: true,
    });
    expect(JSON.stringify(body.details.issues)).not.toContain("10000");
    expect(await storedRow(med.id)).toBeNull();
  });

  it("answers 404 for another account's medication and leaves its row alone", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const theirs = await makeMedication(other);
    await prisma.reminderPhaseConfig.create({
      data: { medicationId: theirs.id, ...CUSTOM },
    });

    const res = await callRoute(PUT, {
      method: "PUT",
      route: ROUTE,
      params: { id: theirs.id },
      body: DEFAULTS,
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(404);
    expect(await storedRow(theirs.id)).toEqual(CUSTOM);
  });
});

describe("DELETE /api/medications/{id}/phase-config", () => {
  it("drops the row so the GET answers the defaults, and resets again without complaint", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);
    const session = await makeSession(owner);
    await prisma.reminderPhaseConfig.create({
      data: { medicationId: med.id, ...CUSTOM },
    });

    const res = await callRoute<{ reset: boolean }>(DELETE, {
      method: "DELETE",
      route: ROUTE,
      params: { id: med.id },
      auth: session,
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ reset: true });
    expect(await storedRow(med.id)).toBeNull();

    const read = await callRoute<PhaseConfig>(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      auth: session,
    });
    expect(read.data).toEqual(DEFAULTS);

    const again = await callRoute<{ reset: boolean }>(DELETE, {
      method: "DELETE",
      route: ROUTE,
      params: { id: med.id },
      auth: session,
    });
    expect(again.status).toBe(200);
    expect(again.data).toEqual({ reset: true });
  });

  it("answers 404 on every verb for another account's medication and keeps its row", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const theirs = await makeMedication(other);
    await prisma.reminderPhaseConfig.create({
      data: { medicationId: theirs.id, ...CUSTOM },
    });
    const session = await makeSession(owner);

    const read = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: theirs.id },
      auth: session,
    });
    const reset = await callRoute(DELETE, {
      method: "DELETE",
      route: ROUTE,
      params: { id: theirs.id },
      auth: session,
    });

    expect(read.status).toBe(404);
    expect(reset.status).toBe(404);
    expect(await storedRow(theirs.id)).toEqual(CUSTOM);
  });
});
