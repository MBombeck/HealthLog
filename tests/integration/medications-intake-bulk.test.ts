/**
 * v1.4.30 — `POST /api/medications/intake/bulk` real-Postgres
 * integration.
 *
 * Asserts the iOS SyncMode bulk-backfill contract:
 *   - inserts a clean batch
 *   - skips entries that point at a medication the user doesn't own
 *   - returns `duplicate` when an idempotencyKey is re-used
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-medications-intake-bulk";
const OTHER_USER_ID = "user-medications-intake-other";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

let ownedMedId = "";
let foreignMedId = "";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  const prisma = getPrismaClient();
  await prisma.user.createMany({
    data: [
      {
        id: TEST_USER_ID,
        username: "intake-bulk",
        email: "intake-bulk@example.test",
        timezone: "Europe/Berlin",
      },
      {
        id: OTHER_USER_ID,
        username: "intake-other",
        email: "intake-other@example.test",
        timezone: "Europe/Berlin",
      },
    ],
  });
  const owned = await prisma.medication.create({
    data: {
      userId: TEST_USER_ID,
      name: "Mounjaro",
      dose: "5mg",
      active: true,
    },
  });
  ownedMedId = owned.id;
  const foreign = await prisma.medication.create({
    data: {
      userId: OTHER_USER_ID,
      name: "Levothyroxin",
      dose: "50µg",
      active: true,
    },
  });
  foreignMedId = foreign.id;

  const session = await prisma.session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/intake/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/medications/intake/bulk (real Postgres)", () => {
  it("inserts a clean batch", async () => {
    const { POST } = await import("@/app/api/medications/intake/bulk/route");
    const res = await POST(
      makeRequest({
        entries: [
          {
            medicationId: ownedMedId,
            scheduledFor: "2026-05-16T08:00:00.000Z",
            takenAt: "2026-05-16T08:02:00.000Z",
          },
          {
            medicationId: ownedMedId,
            scheduledFor: "2026-05-17T08:00:00.000Z",
            skipped: true,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { processed: number; inserted: number; duplicates: number };
    };
    expect(json.data.processed).toBe(2);
    expect(json.data.inserted).toBe(2);

    const stored = await getPrismaClient().medicationIntakeEvent.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toHaveLength(2);
  });

  it("skips entries that reference a medication the user doesn't own", async () => {
    const { POST } = await import("@/app/api/medications/intake/bulk/route");
    const res = await POST(
      makeRequest({
        entries: [
          {
            medicationId: ownedMedId,
            scheduledFor: "2026-05-16T08:00:00.000Z",
          },
          {
            medicationId: foreignMedId,
            scheduledFor: "2026-05-16T08:00:00.000Z",
          },
        ],
      }),
    );
    const json = (await res.json()) as {
      data: {
        inserted: number;
        skipped: Array<{ index: number; reason: string }>;
      };
    };
    expect(json.data.inserted).toBe(1);
    expect(json.data.skipped).toEqual([
      { index: 1, reason: "medication_not_found" },
    ]);
  });

  it("returns `duplicate` when an idempotencyKey is re-used", async () => {
    const { POST } = await import("@/app/api/medications/intake/bulk/route");
    const body = {
      entries: [
        {
          medicationId: ownedMedId,
          scheduledFor: "2026-05-16T08:00:00.000Z",
          idempotencyKey: "ios-sync-key-001",
        },
      ],
    };
    await POST(makeRequest(body));
    const res = await POST(makeRequest(body));
    const json = (await res.json()) as {
      data: { duplicates: number; inserted: number };
    };
    expect(json.data.duplicates).toBe(1);
    expect(json.data.inserted).toBe(0);

    const stored = await getPrismaClient().medicationIntakeEvent.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toHaveLength(1);
  });
});
