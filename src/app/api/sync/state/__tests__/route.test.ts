/**
 * `GET /api/sync/state` is a read.
 *
 * It used to bump `User.lastSyncedAt` on every call, which is the exact
 * side-effecting GET the MCP-audience note in `lib/auth/guards/context.ts` warns against,
 * and it advanced the checkpoint past a window the client had not drained.
 * The checkpoint is now owned by the ingest boundaries; this route reports it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findFirst: vi.fn(), count: vi.fn() },
    moodEntry: { findFirst: vi.fn(), count: vi.fn() },
    medicationIntakeEvent: { findFirst: vi.fn(), count: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null }),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";

const CHECKPOINT = new Date("2026-07-30T08:15:00.000Z");

type SyncStateBody = {
  lastSyncedAt: string | null;
  serverNow: string;
  timezone: string;
};

async function callGet(): Promise<SyncStateBody> {
  const res = (await (
    GET as unknown as (req: unknown) => Promise<{ data: SyncStateBody }>
  )({})) as { data: SyncStateBody };
  return res.data;
}

describe("GET /api/sync/state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.moodEntry.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.measurement.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.moodEntry.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.medicationIntakeEvent.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      lastSyncedAt: CHECKPOINT,
      timezone: "Europe/Berlin",
    } as never);
  });

  it("writes nothing — the handshake never touches the user row", async () => {
    await callGet();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("reports the stored checkpoint rather than the previous handshake", async () => {
    const body = await callGet();
    expect(body.lastSyncedAt).toBe(CHECKPOINT.toISOString());
  });

  it("keeps reporting the same checkpoint across repeated calls", async () => {
    const first = await callGet();
    const second = await callGet();
    expect(second.lastSyncedAt).toBe(first.lastSyncedAt);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("reports a never-synced account as null so the client re-pairs full", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      lastSyncedAt: null,
      timezone: "Europe/Berlin",
    } as never);
    const body = await callGet();
    expect(body.lastSyncedAt).toBeNull();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
