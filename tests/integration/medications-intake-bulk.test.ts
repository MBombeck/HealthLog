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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { localHmAsUtc } from "@/lib/tz/local-day";

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
      // Long expiry so the session survives the cases that pin the clock
      // forward to local noon (a 60-minute expiry would read as expired
      // under the faked time).
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
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

    // A taken-write must never snap onto a FUTURE slot, so the 07:00
    // taken-write cases below pin the clock to local noon (see
    // `pinClockAfterMorningSlot`) so the slot sits in the past even when
    // the suite runs before 07:00 local. Sibling cases that use a later
    // slot or fixed dates keep real time, hence the per-test pin. This
    // afterEach is a no-op for the cases that never faked.
    afterEach(() => {
      vi.useRealTimers();
    });

    // Pin only Date (leaving Prisma's real timers) to today's local noon,
    // computed from the real date so it stays on the current day.
    function pinClockAfterMorningSlot(): void {
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(noon);
    }

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
      pinClockAfterMorningSlot();
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
        data: {
          inserted: number;
          updated: number;
          entries: Array<{ status: string }>;
        };
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
      pinClockAfterMorningSlot();
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
      // Relative past instants: takenAt now carries a no-future plausibility
      // bound, so fixed calendar dates would rot into rejections.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const t1 = new Date(yesterday.setUTCHours(9, 0, 0, 0));
      const t2 = new Date(yesterday.setUTCHours(15, 0, 0, 0));
      await POST(
        makeRequest({
          entries: [
            {
              medicationId: med.id,
              scheduledFor: t1.toISOString(),
              takenAt: t1.toISOString(),
            },
          ],
        }),
      );
      const res = await POST(
        makeRequest({
          entries: [
            {
              medicationId: med.id,
              scheduledFor: t2.toISOString(),
              takenAt: t2.toISOString(),
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
        where: { userId: TEST_USER_ID, medicationId: med.id },
      });
      expect(rows).toHaveLength(2);
    });

    it("creates exactly one row for a fresh scheduled dose with no pre-existing slot row", async () => {
      const prisma = getPrismaClient();
      const medId = await makeScheduledMed(["19:00"]);
      // Yesterday's slot: today's 19:00 is in the future for any run before
      // the evening, and a future takenAt is now rejected by design.
      const slot = localHmAsUtc(
        new Date(Date.now() - 24 * 60 * 60 * 1000),
        TZ,
        19,
        0,
      );

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

  /**
   * Migration 0273 — the idempotency key is unique PER USER.
   *
   * It carried a GLOBAL unique from 0001_init. Because the key is
   * client-supplied, two people running the same client could mint the
   * same one, and then the global constraint refused the second person's
   * write outright: their dose was silently lost. The unscoped replay
   * probe made it worse by resolving the key to the FIRST user's row and
   * handing that stranger's row id back.
   *
   * These two cases are the whole contract: different users must not
   * collide, and one user replaying their own key must still dedup.
   */
  it("lets two different users post the SAME idempotency key — both doses land", async () => {
    const { POST } = await import("@/app/api/medications/intake/bulk/route");
    const prisma = getPrismaClient();
    const SHARED_KEY = "ios-outbox-2026-05-16T08:00";

    // User A posts first.
    const first = await POST(
      makeRequest({
        entries: [
          {
            medicationId: ownedMedId,
            scheduledFor: "2026-05-16T08:00:00.000Z",
            takenAt: "2026-05-16T08:02:00.000Z",
            idempotencyKey: SHARED_KEY,
          },
        ],
      }),
    );
    expect(first.status).toBe(200);
    expect(
      ((await first.json()) as { data: { inserted: number } }).data.inserted,
    ).toBe(1);

    // Now the OTHER user, with their own session and their own medication,
    // posts the very same key.
    const otherSession = await prisma.session.create({
      data: {
        userId: OTHER_USER_ID,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });
    cookieJar.set("healthlog_session", otherSession.id);

    const second = await POST(
      makeRequest({
        entries: [
          {
            medicationId: foreignMedId,
            scheduledFor: "2026-05-16T08:00:00.000Z",
            takenAt: "2026-05-16T08:03:00.000Z",
            idempotencyKey: SHARED_KEY,
          },
        ],
      }),
    );
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string; id?: string }>;
      };
    };
    // The second user's dose LANDS. Pre-0273 it was reported `duplicate`
    // against the first user's row and never written.
    expect(secondJson.data.inserted).toBe(1);
    expect(secondJson.data.duplicates).toBe(0);

    const mine = await prisma.medicationIntakeEvent.findMany({
      where: { userId: OTHER_USER_ID },
      select: { id: true, userId: true, idempotencyKey: true },
    });
    const theirs = await prisma.medicationIntakeEvent.findMany({
      where: { userId: TEST_USER_ID },
      select: { id: true },
    });
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0].idempotencyKey).toBe(SHARED_KEY);
    // And no id belonging to the first user was echoed to the second.
    const echoed = secondJson.data.entries[0]?.id;
    if (echoed) expect(echoed).not.toBe(theirs[0].id);
  });

  it("still dedups when the SAME user replays their own key", async () => {
    const { POST } = await import("@/app/api/medications/intake/bulk/route");
    const prisma = getPrismaClient();
    const KEY = "ios-outbox-replay-001";
    const body = {
      entries: [
        {
          medicationId: ownedMedId,
          scheduledFor: "2026-05-18T08:00:00.000Z",
          takenAt: "2026-05-18T08:02:00.000Z",
          idempotencyKey: KEY,
        },
      ],
    };

    const first = await POST(makeRequest(body));
    expect(
      ((await first.json()) as { data: { inserted: number } }).data.inserted,
    ).toBe(1);

    const replay = await POST(makeRequest(body));
    const replayJson = (await replay.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string; id?: string }>;
      };
    };
    expect(replayJson.data.inserted).toBe(0);
    expect(replayJson.data.duplicates).toBe(1);

    const stored = await prisma.medicationIntakeEvent.findMany({
      where: { userId: TEST_USER_ID, idempotencyKey: KEY },
      select: { id: true },
    });
    expect(stored).toHaveLength(1);
    // The replay resolves to the caller's OWN row.
    expect(replayJson.data.entries[0]?.id).toBe(stored[0].id);
  });

  it("holds the per-user unique at the database, not only in the route", async () => {
    const prisma = getPrismaClient();
    const KEY = "db-level-shared-key";

    await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: ownedMedId,
        scheduledFor: new Date("2026-05-19T08:00:00.000Z"),
        takenAt: new Date("2026-05-19T08:00:00.000Z"),
        source: "WEB",
        idempotencyKey: KEY,
      },
    });

    // Same key, different user — allowed now, refused before 0273.
    await expect(
      prisma.medicationIntakeEvent.create({
        data: {
          userId: OTHER_USER_ID,
          medicationId: foreignMedId,
          scheduledFor: new Date("2026-05-19T08:00:00.000Z"),
          takenAt: new Date("2026-05-19T08:00:00.000Z"),
          source: "WEB",
          idempotencyKey: KEY,
        },
      }),
    ).resolves.toBeTruthy();

    // Same key, SAME user — still refused.
    await expect(
      prisma.medicationIntakeEvent.create({
        data: {
          userId: TEST_USER_ID,
          medicationId: ownedMedId,
          scheduledFor: new Date("2026-05-20T08:00:00.000Z"),
          takenAt: new Date("2026-05-20T08:00:00.000Z"),
          source: "WEB",
          idempotencyKey: KEY,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  /**
   * Migration 0273 step 1 — the reconciliation safety net.
   *
   * Against an intact database it can never fire: the global unique it
   * replaces is strictly stronger than the per-user one, so no colliding
   * pair can exist. It is there for a database whose global index was
   * dropped by hand at some point. That means nothing else in this suite
   * exercises it, so this case builds the collision on purpose and runs
   * the SHIPPED SQL — read from the migration file, not a copy that could
   * drift — against it.
   *
   * The whole thing runs inside a transaction that is rolled back, so the
   * index surgery never escapes into the rest of the run.
   */
  it("migration 0273 reconciles a pre-existing same-user collision without losing a dose", async () => {
    const prisma = getPrismaClient();
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const sql = readFileSync(
      join(
        process.cwd(),
        "prisma",
        "migrations",
        "0273_scope_intake_idempotency_key_per_user",
        "migration.sql",
      ),
      "utf8",
    );
    // Strip comments BEFORE splitting: the prose contains semicolons of
    // its own, and splitting first would slice a statement in half.
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    const safetyNet = statements.find((st) => st.startsWith("UPDATE"));
    const createIndex = statements.find((st) =>
      st.startsWith("CREATE UNIQUE INDEX"),
    );
    expect(
      safetyNet,
      "migration must carry the reconciliation UPDATE",
    ).toBeTruthy();
    expect(createIndex, "migration must carry the per-user index").toBeTruthy();

    const COLLIDING_KEY = "legacy-collision-key";
    let observed: Array<{ id: string; idempotencyKey: string | null }> = [];

    class Rollback extends Error {}
    await expect(
      prisma.$transaction(async (tx) => {
        // Simulate the only database on which the collision is possible:
        // one whose unique index was dropped by hand.
        await tx.$executeRawUnsafe(
          'DROP INDEX "medication_intake_events_user_id_idempotency_key_key"',
        );

        const earlier = await tx.medicationIntakeEvent.create({
          data: {
            id: "collide-earlier",
            userId: TEST_USER_ID,
            medicationId: ownedMedId,
            scheduledFor: new Date("2026-05-21T08:00:00.000Z"),
            takenAt: new Date("2026-05-21T08:00:00.000Z"),
            source: "WEB",
            idempotencyKey: COLLIDING_KEY,
            createdAt: new Date("2026-05-21T08:00:00.000Z"),
          },
        });
        const later = await tx.medicationIntakeEvent.create({
          data: {
            id: "collide-later",
            userId: TEST_USER_ID,
            medicationId: ownedMedId,
            scheduledFor: new Date("2026-05-22T08:00:00.000Z"),
            takenAt: new Date("2026-05-22T08:00:00.000Z"),
            source: "WEB",
            idempotencyKey: COLLIDING_KEY,
            createdAt: new Date("2026-05-22T08:00:00.000Z"),
          },
        });

        // Run the migration's own reconciliation, then its own index.
        await tx.$executeRawUnsafe(safetyNet!);
        await tx.$executeRawUnsafe(createIndex!);

        observed = await tx.medicationIntakeEvent.findMany({
          where: { id: { in: [earlier.id, later.id] } },
          orderBy: { createdAt: "asc" },
          select: { id: true, idempotencyKey: true },
        });
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    // Both doses survive — the migration never deletes or rewrites a row.
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({
      id: "collide-earlier",
      idempotencyKey: COLLIDING_KEY,
    });
    // Only the dedup HINT on the later row is cleared, which is what makes
    // the unique index creatable.
    expect(observed[1]).toEqual({
      id: "collide-later",
      idempotencyKey: null,
    });
  });
});
