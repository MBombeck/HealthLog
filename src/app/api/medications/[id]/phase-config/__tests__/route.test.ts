/**
 * v1.5.5 F-1 H-3 — phase-config PUT now returns the multi-issue 422
 * envelope rather than the flat `400 Invalid input`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    reminderPhaseConfig: { upsert: vi.fn() },
  },
}));

vi.mock("@/lib/medications/route-guards", () => ({
  assertMedicationOwnership: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { PUT } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const ROUTE_PARAMS = { params: Promise.resolve({ id: "med-1" }) };

function putReq(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/medications/med-1/phase-config",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(assertMedicationOwnership).mockResolvedValue(null);
  vi.mocked(prisma.reminderPhaseConfig.upsert).mockResolvedValue({
    medicationId: "med-1",
  } as never);
});

describe("PUT /api/medications/[id]/phase-config — F-1 H-3 multi-issue 422", () => {
  it("returns the multi-issue envelope on a malformed body", async () => {
    // Three issues: greenValue not int, greenMode not enum, redValue overflow.
    const res = await PUT(
      putReq({
        greenValue: "not-a-number",
        greenMode: "BOGUS",
        yellowValue: 30,
        yellowMode: "MINUTES",
        orangeValue: 0,
        orangeMode: "MINUTES",
        redValue: 10_000,
        redMode: "MINUTES",
      }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });
});

describe("PUT /api/medications/[id]/phase-config — F-1 H-4 field-by-field upsert", () => {
  it("builds the create + update payloads field-by-field rather than spreading parsed.data", async () => {
    const body = {
      greenValue: 60,
      greenMode: "MINUTES",
      yellowValue: 30,
      yellowMode: "MINUTES",
      orangeValue: 0,
      orangeMode: "MINUTES",
      redValue: 240,
      redMode: "MINUTES",
    };
    await PUT(putReq(body), ROUTE_PARAMS);

    const callArg = vi.mocked(prisma.reminderPhaseConfig.upsert).mock.calls[0][0];
    // create payload contains exactly the eight enumerated phase fields
    // plus the `medicationId` route binding — nothing else.
    expect(Object.keys(callArg.create).sort()).toEqual([
      "greenMode",
      "greenValue",
      "medicationId",
      "orangeMode",
      "orangeValue",
      "redMode",
      "redValue",
      "yellowMode",
      "yellowValue",
    ]);
    // update payload mirrors the eight phase fields (no `medicationId`).
    expect(Object.keys(callArg.update).sort()).toEqual([
      "greenMode",
      "greenValue",
      "orangeMode",
      "orangeValue",
      "redMode",
      "redValue",
      "yellowMode",
      "yellowValue",
    ]);
  });

  it("ignores an unknown field smuggled in the body (no mass assignment)", async () => {
    const body = {
      greenValue: 60,
      greenMode: "MINUTES",
      yellowValue: 30,
      yellowMode: "MINUTES",
      orangeValue: 0,
      orangeMode: "MINUTES",
      redValue: 240,
      redMode: "MINUTES",
      // Unknown rogue field — should never reach the Prisma upsert.
      maliciousField: "owned",
    };
    await PUT(putReq(body), ROUTE_PARAMS);
    const callArg = vi.mocked(prisma.reminderPhaseConfig.upsert).mock.calls[0][0];
    expect((callArg.create as Record<string, unknown>).maliciousField).toBeUndefined();
    expect((callArg.update as Record<string, unknown>).maliciousField).toBeUndefined();
  });
});
