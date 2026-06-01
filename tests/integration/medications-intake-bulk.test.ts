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
import { localHmAsUtc } from "@/lib/timezone";

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

  // v1.8.2 — duplicate-intake slot collapse. A scheduled med carries a
  // pending REMINDER row at the canonical `localHmAsUtc` slot instant;
  // an iOS "Genommen" write (source API) must UPDATE that row, not insert
  // a second source-API row that differs only by source + sub-minute
  // drift.
  describe("v1.8.2 — source-agnostic slot collapse", () => {
    const TZ = "Europe/Berlin";

    async function makeScheduledMed(timesOfDay: string[]): Promise<string> {
      const prisma = getPrismaClient();
      const med = await prisma.medication.create({
        data: {
          userId: TEST_USER_ID,
          name: "Ramipril",
          dose: "5mg",
          active: true,
          schedules: {
            create: {
              windowStart: timesOfDay[0],
              windowEnd: timesOfDay[0],
              timesOfDay,
              daysOfWeek: null,
              scheduleType: "SCHEDULED",
            },
          },
        },
      });
      return med.id;
    }

    it("collapses an API taken-write onto a pre-existing pending REMINDER slot row (exact instant)", async () => {
      const prisma = getPrismaClient();
      const medId = await makeScheduledMed(["07:00"]);
      // The projector/worker minted this pending REMINDER row.
      const slot = localHmAsUtc(new Date(), TZ, 7, 0);
      const pending = await prisma.medicationIntakeEvent.create({
        data: {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: slot,
          takenAt: null,
          skipped: false,
          source: "REMINDER",
        },
      });

      const { POST } = await import("@/app/api/medications/intake/bulk/route");
      const res = await POST(
        makeRequest({
          entries: [
            {
              medicationId: medId,
              scheduledFor: slot.toISOString(),
              takenAt: slot.toISOString(),
            },
          ],
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { inserted: number; updated: number; entries: Array<{ status: string }> };
      };
      expect(json.data.inserted).toBe(0);
      expect(json.data.updated).toBe(1);
      expect(json.data.entries[0]?.status).toBe("updated");

      const rows = await prisma.medicationIntakeEvent.findMany({
        where: { userId: TEST_USER_ID, medicationId: medId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(pending.id);
      expect(rows[0]?.takenAt).not.toBeNull();
      expect(rows[0]?.source).toBe("REMINDER"); // original source preserved
    });

    it("collapses even when the write's scheduledFor drifts by 1 minute", async () => {
      const prisma = getPrismaClient();
      const medId = await makeScheduledMed(["07:00"]);
      const slot = localHmAsUtc(new Date(), TZ, 7, 0);
      await prisma.medicationIntakeEvent.create({
        data: {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: slot,
          takenAt: null,
          skipped: false,
          source: "REMINDER",
        },
      });

      const drifted = new Date(slot.getTime() + 60_000); // +1 min
      const { POST } = await import("@/app/api/medications/intake/bulk/route");
      const res = await POST(
        makeRequest({
          entries: [
            {
              medicationId: medId,
              scheduledFor: drifted.toISOString(),
              takenAt: drifted.toISOString(),
            },
          ],
        }),
      );
      const json = (await res.json()) as {
        data: { inserted: number; updated: number };
      };
      expect(json.data.updated).toBe(1);
      expect(json.data.inserted).toBe(0);

      const rows = await prisma.medicationIntakeEvent.findMany({
        where: { userId: TEST_USER_ID, medicationId: medId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.scheduledFor.toISOString()).toBe(slot.toISOString());
    });

    it("C2 — a pending echo onto an already-TAKEN slot does NOT clear takenAt", async () => {
      // Medical-safety invariant: an iOS offline re-sync replays a PENDING
      // projection (no takenAt, skipped=false) for a slot the user already
      // marked TAKEN. That echo must NOT downgrade the recorded dose.
      const prisma = getPrismaClient();
      const medId = await makeScheduledMed(["07:00"]);
      const slot = localHmAsUtc(new Date(), TZ, 7, 0);
      const takenAt = new Date(slot.getTime() + 90_000); // taken 1.5 min late
      const taken = await prisma.medicationIntakeEvent.create({
        data: {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: slot,
          takenAt,
          skipped: false,
          source: "WEB",
        },
      });

      const { POST } = await import("@/app/api/medications/intake/bulk/route");
      const res = await POST(
        makeRequest({
          entries: [
            {
              medicationId: medId,
              scheduledFor: slot.toISOString(),
              // no takenAt, skipped omitted → pending projection echo
            },
          ],
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: {
          inserted: number;
          updated: number;
          duplicates: number;
          entries: Array<{ status: string }>;
        };
      };
      // Reported as duplicate so the iOS cursor advances WITHOUT downgrading.
      expect(json.data.duplicates).toBe(1);
      expect(json.data.updated).toBe(0);
      expect(json.data.inserted).toBe(0);
      expect(json.data.entries[0]?.status).toBe("duplicate");

      const rows = await prisma.medicationIntakeEvent.findMany({
        where: { userId: TEST_USER_ID, medicationId: medId, deletedAt: null },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(taken.id);
      // The recorded dose is intact — takenAt was NOT cleared.
      expect(rows[0]?.takenAt?.toISOString()).toBe(takenAt.toISOString());
    });

    it("does NOT collapse PRN doses — two as-needed logs keep two rows", async () => {
      const prisma = getPrismaClient();
      const med = await prisma.medication.create({
        data: {
          userId: TEST_USER_ID,
          name: "Ibuprofen",
          dose: "400mg",
          active: true,
          schedules: {
            create: {
              windowStart: "00:00",
              windowEnd: "00:00",
              timesOfDay: [],
              daysOfWeek: null,
              scheduleType: "PRN",
            },
          },
        },
      });

      const { POST } = await import("@/app/api/medications/intake/bulk/route");
      const t1 = new Date("2026-06-15T09:00:00.000Z");
      const t2 = new Date("2026-06-15T15:00:00.000Z");
      await POST(
        makeRequest({
          entries: [
            { medicationId: med.id, scheduledFor: t1.toISOString(), takenAt: t1.toISOString() },
          ],
        }),
      );
      const res = await POST(
        makeRequest({
          entries: [
            { medicationId: med.id, scheduledFor: t2.toISOString(), takenAt: t2.toISOString() },
          ],
        }),
      );
      const json = (await res.json()) as {
        data: { inserted: number; updated: number };
      };
      expect(json.data.inserted).toBe(1);
      expect(json.data.updated).toBe(0);

      const rows = await prisma.medicationIntakeEvent.findMany({
        where: { userId: TEST_USER_ID, medicationId: med.id },
      });
      expect(rows).toHaveLength(2);
    });

    it("creates exactly one row for a fresh scheduled dose with no pre-existing slot row", async () => {
      const prisma = getPrismaClient();
      const medId = await makeScheduledMed(["19:00"]);
      const slot = localHmAsUtc(new Date(), TZ, 19, 0);

      const { POST } = await import("@/app/api/medications/intake/bulk/route");
      const res = await POST(
        makeRequest({
          entries: [
            {
              medicationId: medId,
              scheduledFor: slot.toISOString(),
              takenAt: slot.toISOString(),
            },
          ],
        }),
      );
      const json = (await res.json()) as {
        data: { inserted: number; updated: number };
      };
      expect(json.data.inserted).toBe(1);
      expect(json.data.updated).toBe(0);

      const rows = await prisma.medicationIntakeEvent.findMany({
        where: { userId: TEST_USER_ID, medicationId: medId },
      });
      expect(rows).toHaveLength(1);
      // snapped to the canonical slot instant
      expect(rows[0]?.scheduledFor.toISOString()).toBe(slot.toISOString());
    });
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
