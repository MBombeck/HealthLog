/**
 * `GET /api/admin/maintenance/measurements` — the status the admin card
 * starts and follows the run with. Admin-only, and a web-only deployment
 * (no pg-boss schema) answers `available: false` instead of failing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { runStateOf } from "@/lib/jobs/measurement-maintenance-status";

const ADMIN = {
  session: { id: "s-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "admin", role: "ADMIN" as const },
};
const USER = {
  session: { id: "s-2", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "bob", role: "USER" as const },
};

const get = () =>
  (GET as unknown as (r: NextRequest) => Promise<Response>)(
    new NextRequest("http://localhost/api/admin/maintenance/measurements"),
  );

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/admin/maintenance/measurements", () => {
  it("is refused to anyone but an admin", async () => {
    vi.mocked(getSession).mockResolvedValue(USER as never);
    expect((await get()).status).toBe(403);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("reports a running pass, the purge and the table size", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN as never);
    vi.mocked(prisma.$queryRaw)
      // sizes
      .mockResolvedValueOnce([
        { table_bytes: BigInt(5_000_000_000), index_bytes: BigInt(2e9) },
      ] as never)
      // newest run
      .mockResolvedValueOnce([
        {
          state: "active",
          created_on: new Date("2026-10-08T08:00:00Z"),
          started_on: new Date("2026-10-08T08:00:05Z"),
          completed_on: null,
          outcome: null,
        },
      ] as never)
      // purge queue
      .mockResolvedValueOnce([{ n: 0 }] as never);

    const body = await (await get()).json();
    expect(body.data).toEqual({
      available: true,
      purgePending: false,
      run: {
        state: "running",
        requestedAt: "2026-10-08T08:00:00.000Z",
        startedAt: "2026-10-08T08:00:05.000Z",
        finishedAt: null,
        outcome: null,
      },
      sizes: { tableBytes: 5_000_000_000, indexBytes: 2_000_000_000 },
    });
  });

  it("says when a finished run refused because the purge was still working", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN as never);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { table_bytes: BigInt(1), index_bytes: BigInt(1) },
      ] as never)
      .mockResolvedValueOnce([
        {
          state: "completed",
          created_on: new Date("2026-10-08T08:00:00Z"),
          started_on: new Date("2026-10-08T08:00:01Z"),
          completed_on: new Date("2026-10-08T08:00:02Z"),
          outcome: "refused_purge_running",
        },
      ] as never)
      .mockResolvedValueOnce([{ n: 1 }] as never);

    const body = await (await get()).json();
    expect(body.data.purgePending).toBe(true);
    expect(body.data.run.outcome).toBe("refused_purge_running");
  });

  it("answers available: false where there is no queue to ask", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN as never);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { table_bytes: BigInt(10), index_bytes: BigInt(4) },
      ] as never)
      .mockRejectedValue(new Error('relation "pgboss.job" does not exist'));

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      available: false,
      purgePending: false,
      run: null,
      sizes: { tableBytes: 10, indexBytes: 4 },
    });
  });
});

describe("runStateOf", () => {
  it("maps every pg-boss state onto the card's four", () => {
    expect(runStateOf("created")).toBe("queued");
    expect(runStateOf("retry")).toBe("queued");
    expect(runStateOf("active")).toBe("running");
    expect(runStateOf("completed")).toBe("completed");
    expect(runStateOf("failed")).toBe("failed");
    expect(runStateOf("cancelled")).toBe("failed");
  });
});
