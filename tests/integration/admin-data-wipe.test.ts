/**
 * Integration guard for `DELETE /api/admin/data` — the global "wipe all data".
 *
 * This is the wipe an operator runs before handing a box on, and it deleted
 * nine tables. The list was inline, written when nine was most of the schema,
 * and it stayed at nine while the schema grew past a hundred: laboratory
 * results, documents, cycle logs, journals, mood, workouts, sleep and Coach
 * conversations all survived a confirmation typed by hand. The previous
 * version of this file asserted the three tables a v1.4.6 fix had added and
 * was green the whole time — it could only see the tables it named.
 *
 * So it now works the way the account-wipe guard does: seed a row into every
 * table in the schema, for two different accounts, run the wipe, and ask the
 * database what is left. What it asserts:
 *
 *   - every model in `ADMIN_WIPE_MODELS` is empty across the WHOLE table, not
 *     merely for the admin who pressed the button;
 *   - every table reached only through a database cascade is empty too;
 *   - the exempt sets still hold their rows, so the "kept" half of the
 *     confirmation copy is true;
 *   - the instance-scoped tables are untouched;
 *   - every `User` row survives with `USER_RESET` applied;
 *   - the audit history goes and exactly one receipt row replaces it.
 *
 * Its honest limit: it proves the wipe removes what the plan declares. The
 * plan being right is what `src/__tests__/admin-data-wipe-completeness.test.ts`
 * holds against `schema.prisma`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { countRows, modelTableMap, seedEveryTable } from "./wipe-seeder";
import {
  ADMIN_WIPE_EXEMPT,
  ADMIN_WIPE_MODELS,
  INSTANCE_SCOPED,
  USER_KEPT_FIELDS,
  USER_RESET,
  WIPE_EXEMPT,
} from "@/lib/data-wipe/wipe-plan";

// next/headers cookie + ip headers stub for getSession() inside
// requireAdmin(). The admin route reads x-forwarded-for too; we stub
// both to keep the handler reachable. Maps live in
// `mock-next-headers.ts` — see that file for the rationale (suite
// runs with vitest `isolate: false`, so per-file Maps would leak).
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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function runWipe(): Promise<Response> {
  const { DELETE } = await import("@/app/api/admin/data/route");
  const req = new Request("http://localhost/api/admin/data", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify({ confirm: "DELETE ALL" }),
  });
  return DELETE(req as unknown as Parameters<typeof DELETE>[0]);
}

describe("DELETE /api/admin/data leaves nothing it promised to delete", () => {
  it("empties every in-scope table for every account and keeps exactly the declared set", async () => {
    const prisma = getPrismaClient();
    const tables = modelTableMap();

    const admin = await prisma.user.create({
      data: {
        username: "wipe-admin",
        email: "wipe-admin@example.test",
        role: "ADMIN",
        passwordHash: "argon2-placeholder",
        heightCm: 180,
        dateOfBirth: new Date("1990-01-01T00:00:00Z"),
        telegramBotToken: "secret-token",
        telegramEnabled: true,
        // Off, so the reset back to the default (on) is visible below.
        environmentAirQualityEnabled: false,
        locale: "en",
        unitPreference: "metric",
      },
    });

    // The whole point of this route is that it reaches accounts other than
    // the one pressing the button. A second account's rows are seeded by
    // hand across the domains the old nine-table list left behind.
    const other = await prisma.user.create({
      data: {
        username: "wipe-bystander",
        email: "wipe-bystander@example.test",
        passwordHash: "argon2-placeholder",
        heightCm: 165,
        onboardingCompletedAt: new Date(),
      },
    });
    await prisma.measurement.create({
      data: {
        userId: other.id,
        type: "WEIGHT",
        value: 70,
        unit: "kg",
        measuredAt: new Date(),
      },
    });
    await prisma.labResult.create({
      data: {
        userId: other.id,
        analyte: "HbA1c",
        value: 5.4,
        unit: "%",
        takenAt: new Date(),
      },
    });
    await prisma.coachConversation.create({
      data: { userId: other.id, title: "bystander conversation" },
    });
    await prisma.workout.create({
      data: {
        userId: other.id,
        sportType: "running",
        startedAt: new Date("2026-01-01T06:00:00Z"),
        endedAt: new Date("2026-01-01T06:30:00Z"),
        durationSec: 1800,
      },
    });

    const seeded = await seedEveryTable(prisma, admin.id);
    expect(
      seeded.length,
      "the seeder should reach essentially the whole schema",
    ).toBeGreaterThan(100);

    // Created after the generic seed so the cookie carries this session's id.
    // The seed gives the admin a second factor, and the wipe asks for a fresh
    // proof, so the session is one that has just completed it.
    const session = await prisma.session.create({
      data: {
        userId: admin.id,
        expiresAt: new Date(Date.now() + 60_000),
        mfaVerifiedAt: new Date(),
      },
    });
    cookieJar.set("healthlog_session", session.id);

    // ── act ──
    const response = await runWipe();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { cleared: boolean; deletedRows: number };
    };
    expect(body.data.cleared).toBe(true);
    expect(body.data.deletedRows).toBeGreaterThan(50);

    // ── assert: nothing the plan claims to delete is left, for anyone ──
    const survivors: string[] = [];
    for (const model of ADMIN_WIPE_MODELS) {
      const table = tables.get(model)!;
      // `AuditLog` is wiped inside the transaction and then receives exactly
      // one new row after it commits: the receipt for the wipe itself.
      const expected = model === "AuditLog" ? 1 : 0;
      if ((await countRows(prisma, table)) > expected) {
        survivors.push(`${model} (${table})`);
      }
    }
    expect(
      survivors,
      `rows survived a wipe that told the operator everything was deleted:\n${survivors.join("\n")}`,
    ).toEqual([]);

    const auditRows = await prisma.auditLog.findMany({
      select: { action: true },
    });
    expect(auditRows.map((r) => r.action)).toEqual(["admin.data.clear"]);

    // ── assert: the kept set is exactly what the copy promises ──
    const missing: string[] = [];
    for (const model of [
      ...Object.keys(WIPE_EXEMPT),
      ...Object.keys(ADMIN_WIPE_EXEMPT),
    ]) {
      const table = tables.get(model)!;
      if ((await countRows(prisma, table)) === 0) {
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
        `${model} belongs to the instance and must survive the data wipe`,
      ).toBeGreaterThan(0);
    }

    // ── assert: everything reached only by cascade is gone too ──
    const wipedTables = new Set(ADMIN_WIPE_MODELS.map((m) => tables.get(m)!));
    const keptTables = new Set(
      [
        ...Object.keys(WIPE_EXEMPT),
        ...Object.keys(ADMIN_WIPE_EXEMPT),
        ...Object.keys(INSTANCE_SCOPED),
      ].map((m) => tables.get(m)!),
    );
    const leftovers: string[] = [];
    for (const table of seeded) {
      if (wipedTables.has(table)) continue;
      if (keptTables.has(table)) continue;
      if ((await countRows(prisma, table)) > 0) leftovers.push(table);
    }
    expect(
      leftovers,
      `tables the wipe reaches only through a database cascade still hold rows:\n${leftovers.join("\n")}`,
    ).toEqual([]);

    // ── assert: both accounts survive, reset but signed-in-able ──
    const rows = await prisma.user.findMany({ orderBy: { username: "asc" } });
    expect(rows.map((r) => r.username)).toEqual([
      "wipe-admin",
      "wipe-bystander",
    ]);

    for (const row of rows) {
      const record = row as unknown as Record<string, unknown>;
      expect(record.passwordHash).toBe("argon2-placeholder");
      for (const column of Object.keys(USER_KEPT_FIELDS)) {
        expect(record).toHaveProperty(column);
      }

      const stillSet: string[] = [];
      for (const column of Object.keys(USER_RESET)) {
        const value = record[column];
        const cleared =
          value === null ||
          value === false ||
          value === 0 ||
          (Array.isArray(value) && value.length === 0) ||
          value === "aggregated" ||
          value === "disconnected" ||
          // A column whose reset is a non-empty default (v1.42: the
          // air-quality switch resets to on) is cleared when it holds
          // exactly that default.
          (typeof value === "boolean" &&
            (USER_RESET as Record<string, unknown>)[column] === value);
        if (!cleared) stillSet.push(`${column} = ${JSON.stringify(value)}`);
      }
      expect(
        stillSet,
        `${record.username}: User columns the plan resets still carry a value:\n${stillSet.join("\n")}`,
      ).toEqual([]);
    }

    // The admin who ran it is still signed in — the session that carried the
    // request has to outlive it or the operator is logged out mid-action.
    expect(await prisma.session.count({ where: { id: session.id } })).toBe(1);
  });

  it("refuses a wipe without the typed confirmation", async () => {
    const prisma = getPrismaClient();
    const admin = await prisma.user.create({
      data: {
        username: "wipe-admin-unconfirmed",
        email: "wipe-admin-unconfirmed@example.test",
        role: "ADMIN",
      },
    });
    const session = await prisma.session.create({
      data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    await prisma.measurement.create({
      data: {
        userId: admin.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(),
      },
    });

    const { DELETE } = await import("@/app/api/admin/data/route");
    const res = await DELETE(
      new Request("http://localhost/api/admin/data", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({ confirm: "delete all" }),
      }) as unknown as Parameters<typeof DELETE>[0],
    );

    expect(res.status).toBe(422);
    expect(await prisma.measurement.count()).toBe(1);
  });
});
