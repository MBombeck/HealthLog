/**
 * Integration guard for `DELETE /api/settings/data` — "Delete All Data".
 *
 * The whole defect is about rows that survive, so a mocked Prisma proves
 * nothing: it can only show that the calls the route makes were made. This
 * runs against real Postgres, seeds a row into every table in the schema, runs
 * the wipe, and then asks the database what is left.
 *
 * The seeding is driven by `information_schema` and `pg_constraint` rather
 * than a hand-written fixture, for the same reason the wipe list is derived
 * rather than hand-written: a fixture written today covers the schema of
 * today. A table added next year is seeded automatically and therefore
 * asserted automatically. It lives in `./wipe-seeder` because the admin wipe
 * has to be measured with the same ruler.
 *
 * What it asserts:
 *   - every model in `WIPE_MODELS` has zero rows for the account afterwards;
 *   - every model in `WIPE_EXEMPT` still has its row, so the "kept" half of
 *     the confirmation copy is true too;
 *   - every table the wipe reaches only through a database cascade is empty;
 *   - the instance-scoped tables are untouched;
 *   - the `User` row survives with `USER_RESET` applied and
 *     `USER_KEPT_FIELDS` intact.
 *
 * Its honest limit: it proves the wipe removes what the plan declares. The
 * plan being right is what `src/__tests__/data-wipe-completeness.test.ts`
 * holds against `schema.prisma`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { countRows, modelTableMap, seedEveryTable } from "./wipe-seeder";
import {
  INSTANCE_SCOPED,
  USER_KEPT_FIELDS,
  USER_RESET,
  WIPE_EXEMPT,
  WIPE_MODELS,
} from "@/lib/data-wipe/wipe-plan";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  claimManagedGuardianEgressAuthorization,
  resolveNotificationDeliveryIdentity,
} from "@/lib/notifications/delivery-identity";

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

async function managedProfileLockIsHeld(
  prisma: PrismaClient,
  profileId: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT NOT pg_try_advisory_xact_lock(
      hashtextextended(${`managed-profile:${profileId}`}, 0)
    ) AS locked
  `;
  return rows[0]?.locked === true;
}

describe("DELETE /api/settings/data leaves nothing it promised to delete", () => {
  beforeEach(async () => {
    await truncateAllTables(getPrismaClient());
    cookieJar.clear();
    headerJar.clear();
  });

  it("wipes every in-scope table and keeps exactly the declared set", async () => {
    const prisma = getPrismaClient();
    const tables = modelTableMap();

    const user = await prisma.user.create({
      data: {
        username: "wipe-subject",
        email: "wipe-subject@example.test",
        heightCm: 180,
        dateOfBirth: new Date("1990-01-01T00:00:00Z"),
        gender: "OTHER",
        fullName: "Seeded Name",
        insurerName: "Seeded Insurer",
        stravaAthleteId: "12345",
        thresholdsJson: { sys: 130 },
        onboardingCompletedAt: new Date(),
        passwordHash: "argon2-placeholder",
        locale: "en",
        unitPreference: "metric",
      },
    });

    const seeded = await seedEveryTable(prisma, user.id);
    expect(
      seeded.length,
      "the seeder should reach essentially the whole schema",
    ).toBeGreaterThan(100);

    // The session has to be created after the generic seed so its id is the
    // one the cookie carries. `mfaVerifiedAt` is set because the seeder also
    // planted a WebAuthn MFA credential, which makes the account MFA-enrolled
    // and puts the route behind a fresh step-up.
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
        mfaVerifiedAt: new Date(),
      },
    });
    cookieJar.set("healthlog_session", session.id);

    // ── act ──
    const { DELETE } = await import("@/app/api/settings/data/route");
    const response = await DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      }) as never,
    );
    expect(response.status).toBe(200);

    // ── assert: nothing the plan claims to delete is left ──
    const survivors: string[] = [];
    for (const model of WIPE_MODELS) {
      const table = tables.get(model)!;
      // `AuditLog` is wiped inside the transaction and then receives exactly
      // one new row after it commits: the receipt for the wipe itself. The
      // history is gone; the record that the person asked for it is not.
      const expected = model === "AuditLog" ? 1 : 0;
      if ((await countRows(prisma, table, user.id, model)) > expected) {
        survivors.push(`${model} (${table})`);
      }
    }
    expect(
      survivors,
      `rows survived a wipe that told the person everything was deleted:\n${survivors.join("\n")}`,
    ).toEqual([]);

    // The one surviving audit row is the receipt, not leftover history.
    const auditRows = await prisma.auditLog.findMany({
      where: { userId: user.id },
      select: { action: true },
    });
    expect(auditRows.map((r) => r.action)).toEqual(["user.data.clear"]);

    // ── assert: the kept set is exactly what the copy promises ──
    const missing: string[] = [];
    for (const model of Object.keys(WIPE_EXEMPT)) {
      const table = tables.get(model)!;
      if ((await countRows(prisma, table, user.id)) === 0) {
        missing.push(`${model} (${table})`);
      }
    }
    expect(
      missing,
      `the copy says these are kept, and they are gone:\n${missing.join("\n")}`,
    ).toEqual([]);

    // ── assert: the instance's own tables are untouched ──
    for (const model of Object.keys(INSTANCE_SCOPED)) {
      if (model === "User") continue;
      const table = tables.get(model)!;
      expect(
        await countRows(prisma, table),
        `${model} belongs to the instance and must survive one account's wipe`,
      ).toBeGreaterThan(0);
    }

    // ── assert: everything reached only by cascade is gone too ──
    const wipedTables = new Set(WIPE_MODELS.map((m) => tables.get(m)!));
    const exemptTables = new Set(
      Object.keys(WIPE_EXEMPT).map((m) => tables.get(m)!),
    );
    const instanceTables = new Set(
      Object.keys(INSTANCE_SCOPED).map((m) => tables.get(m)!),
    );
    const leftovers: string[] = [];
    for (const table of seeded) {
      if (wipedTables.has(table)) continue;
      if (exemptTables.has(table)) continue;
      if (instanceTables.has(table)) continue;
      if ((await countRows(prisma, table)) > 0) leftovers.push(table);
    }
    expect(
      leftovers,
      `tables the wipe reaches only through a database cascade still hold rows:\n${leftovers.join("\n")}`,
    ).toEqual([]);

    // ── assert: the account survives, reset but signed-in-able ──
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const record = after as unknown as Record<string, unknown>;

    expect(record.username).toBe("wipe-subject");
    expect(record.passwordHash).toBe("argon2-placeholder");
    for (const column of Object.keys(USER_KEPT_FIELDS)) {
      expect(record).toHaveProperty(column);
    }
    expect(record.locale).toBe("en");
    expect(record.unitPreference).toBe("metric");

    const stillSet: string[] = [];
    for (const column of Object.keys(USER_RESET)) {
      const value = record[column];
      const cleared =
        value === null ||
        value === false ||
        value === 0 ||
        (Array.isArray(value) && value.length === 0) ||
        value === "aggregated" ||
        value === "disconnected";
      if (!cleared) stillSet.push(`${column} = ${JSON.stringify(value)}`);
    }
    expect(
      stillSet,
      `User columns the plan resets still carry a value:\n${stillSet.join("\n")}`,
    ).toEqual([]);
  });

  it("refuses a wipe that would remove a managed profile's last Guardian", async () => {
    const prisma = getPrismaClient();
    const [guardian, profile] = await Promise.all([
      prisma.user.create({
        data: {
          username: "wipe-last-guardian",
          email: "wipe-last-guardian@example.test",
        },
      }),
      prisma.user.create({
        data: {
          username: "wipe-last-profile",
          email: "wipe-last-profile@example.test",
          managedProfileAt: new Date(),
        },
      }),
    ]);
    await prisma.accountGrant.create({
      data: {
        grantorId: profile.id,
        granteeId: guardian.id,
        access: "MANAGE",
        acceptedAt: new Date(),
      },
    });
    await prisma.measurement.create({
      data: {
        userId: guardian.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(),
      },
    });
    const session = await prisma.session.create({
      data: { userId: guardian.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const { DELETE } = await import("@/app/api/settings/data/route");
    const response = await DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      }) as never,
    );

    expect(response.status).toBe(409);
    expect(
      await prisma.accountGrant.count({
        where: { grantorId: profile.id, granteeId: guardian.id },
      }),
    ).toBe(1);
    expect(
      await prisma.measurement.count({ where: { userId: guardian.id } }),
    ).toBe(1);
  });

  it("makes a queued Guardian claim observe a completed data wipe", async () => {
    const prisma = getPrismaClient();
    const [guardian, reserveGuardian, profile] = await Promise.all([
      prisma.user.create({
        data: {
          username: "wipe-race-guardian",
          email: "wipe-race-guardian@example.test",
        },
      }),
      prisma.user.create({
        data: {
          username: "wipe-race-reserve",
          email: "wipe-race-reserve@example.test",
        },
      }),
      prisma.user.create({
        data: {
          username: "wipe-race-profile",
          email: "wipe-race-profile@example.test",
          managedProfileAt: new Date(),
        },
      }),
    ]);
    await Promise.all([
      prisma.accountGrant.create({
        data: {
          grantorId: profile.id,
          granteeId: guardian.id,
          access: "MANAGE",
          acceptedAt: new Date(),
        },
      }),
      prisma.accountGrant.create({
        data: {
          grantorId: profile.id,
          granteeId: reserveGuardian.id,
          access: "MANAGE",
          acceptedAt: new Date(),
        },
      }),
    ]);
    expect(
      await prisma.accountGrant.count({
        where: {
          grantorId: profile.id,
          access: "MANAGE",
          acceptedAt: { not: null },
          revokedAt: null,
        },
      }),
    ).toBe(2);
    const measurement = await prisma.measurement.create({
      data: {
        userId: guardian.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(),
      },
    });
    const session = await prisma.session.create({
      data: { userId: guardian.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    const delivery = await resolveNotificationDeliveryIdentity({
      eventType: "MEDICATION_REMINDER",
      userId: profile.id,
      recordUserId: profile.id,
      recipientUserId: guardian.id,
      title: "record reminder",
      message: "record message",
    });
    expect(delivery).toMatchObject({ managed: true });

    let releaseMeasurement!: () => void;
    let markMeasurementLocked!: () => void;
    const measurementLocked = new Promise<void>((resolve) => {
      markMeasurementLocked = resolve;
    });
    const holdMeasurement = new Promise<void>((resolve) => {
      releaseMeasurement = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.measurement.update({
        where: { id: measurement.id },
        data: { value: 81 },
      });
      markMeasurementLocked();
      await holdMeasurement;
    });
    await measurementLocked;

    const { DELETE } = await import("@/app/api/settings/data/route");
    const wipe = DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      }) as never,
    );
    await vi.waitFor(async () => {
      expect(await managedProfileLockIsHeld(prisma, profile.id)).toBe(true);
    });

    const claim = claimManagedGuardianEgressAuthorization(
      delivery!,
      "NTFY",
      "MEDICATION_REMINDER",
    );
    await expectPromiseToRemainPending(claim);

    releaseMeasurement();
    await blocker;
    expect((await wipe).status).toBe(200);
    await expect(claim).resolves.toBeNull();
    expect(await prisma.notificationEgressAuthorization.count()).toBe(0);
    expect(await prisma.pushAttempt.count()).toBe(0);
  });

  it("refuses without the typed confirmation and leaves the record alone", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: { username: "wipe-refused", email: "wipe-refused@example.test" },
    });
    const session = await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(),
      },
    });

    const { DELETE } = await import("@/app/api/settings/data/route");
    const response = await DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "nope" }),
      }) as never,
    );

    expect(response.status).toBe(422);
    expect(await prisma.measurement.count({ where: { userId: user.id } })).toBe(
      1,
    );
  });

  it("revokes a clinician share link so the token resolves to nothing", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: { username: "wipe-sharer", email: "wipe-sharer@example.test" },
    });
    const session = await prisma.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const { hashToken } = await import("@/lib/auth/hmac");
    const rawToken = `hls_${"a".repeat(48)}`;
    await prisma.clinicianShareLink.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        label: "Practice",
        rangeStart: new Date("2026-01-01T00:00:00Z"),
        sectionsJson: {},
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const { resolveShareToken } =
      await import("@/lib/clinician-share/resolve-share-token");
    expect(await resolveShareToken(rawToken)).not.toBeNull();

    const { DELETE } = await import("@/app/api/settings/data/route");
    const response = await DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      }) as never,
    );
    expect(response.status).toBe(200);

    // A clinician holding the link now reads nothing, not a stale record.
    expect(await resolveShareToken(rawToken)).toBeNull();
  });
});

async function expectPromiseToRemainPending(promise: Promise<unknown>) {
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  expect(settled).toBe(false);
}
