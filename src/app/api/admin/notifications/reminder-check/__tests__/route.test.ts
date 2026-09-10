/**
 * The admin reminder sweep's SCOPE, which is the half of this route that is
 * easy to state backwards.
 *
 * The route dispatches. Every overdue slot it finds enters the channel cascade
 * and reaches whoever owns the medication, so an unscoped run is a writer into
 * every account on the instance at once — not a reader that somebody else might
 * disturb. These cases pin both arms: no body means the long-standing
 * instance-wide sweep, and a named account means a `where` that cannot reach
 * anyone else.
 *
 * Mutation check: drop the `userId` spread from the route's `where` and the
 * second case fails on the filter it no longer carries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { count: vi.fn() },
  },
}));

vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(async () => undefined),
}));

import { POST } from "../route";
import { requireAdmin } from "@/lib/api-handler";
import { prisma } from "@/lib/db";

const ADMIN_CTX = {
  authMethod: "cookie" as const,
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "admin", role: "ADMIN" } as never,
};

const URL_ = "http://localhost/api/admin/notifications/reminder-check";

/** The admin console's own call: no body, no content-type. */
function bare(): NextRequest {
  return new NextRequest(URL_, { method: "POST" });
}

function withBody(body: unknown): NextRequest {
  return new NextRequest(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function whereOfLastFindMany(): Record<string, unknown> {
  const call = vi.mocked(prisma.medication.findMany).mock.calls.at(-1);
  return (call?.[0] as { where: Record<string, unknown> }).where;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    reminderMissedMinutes: 240,
  } as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.count).mockResolvedValue(0 as never);
});

describe("POST /api/admin/notifications/reminder-check", () => {
  it("sweeps the whole instance when no account is named", async () => {
    const res = await POST(bare());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { scoped: boolean } };
    expect(json.data.scoped).toBe(false);
    expect(whereOfLastFindMany()).toEqual({ active: true });
  });

  it("narrows the sweep to the named account", async () => {
    const res = await POST(withBody({ userId: "cku0mock0account0id" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { scoped: boolean } };
    expect(json.data.scoped).toBe(true);
    expect(whereOfLastFindMany()).toEqual({
      active: true,
      userId: "cku0mock0account0id",
    });
  });

  it("refuses an unknown body key rather than sweeping everything", async () => {
    const res = await POST(withBody({ userid: "cku0mock0account0id" }));
    expect(res.status).toBe(422);
    expect(prisma.medication.findMany).not.toHaveBeenCalled();
  });

  it("refuses an account selector that is not an id", async () => {
    const res = await POST(withBody({ userId: "../../etc/passwd" }));
    expect(res.status).toBe(422);
    expect(prisma.medication.findMany).not.toHaveBeenCalled();
  });
});
