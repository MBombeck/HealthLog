/**
 * The recovery kit against real Postgres, through its routes.
 *
 *   - the kit lists the application key, the token key and, when set, the
 *     off-host backup key, by id and fingerprint and never key material;
 *   - a confirmation of a kit the admin was not shown is refused with 409
 *     and records nothing; the right one records the set and is audited;
 *   - a rotation makes the kit due again, and the retired key stays listed,
 *     named, for as long as a stored copy lists it, also once the server no
 *     longer holds it; when the last such copy is gone it drops out;
 *   - the readiness model names a needed key nobody confirmed by its id;
 *   - "Check my copy" answers a boolean for each kind of key, stores
 *     nothing, and is rate limited;
 *   - migration 0487 carries a confirmation given under the old one-key step
 *     forward as a kit holding that key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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

import { _resetCryptoCacheForTests, getKeyFingerprint } from "@/lib/crypto";
import { offhostKeyId } from "@/lib/jobs/offhost-key";
import type { RecoveryKit } from "@/lib/recovery/kit-rules";

const KEY_A =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_B =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const BACKUP_KEY = "ab".repeat(32);
const DAY = 86_400_000;

function useKeys(keys: Record<string, string>, active: string) {
  vi.stubEnv("ENCRYPTION_KEY", "");
  vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify(keys));
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", active);
  _resetCryptoCacheForTests();
}

async function seedAdmin(createdAt = new Date()): Promise<string> {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "kit-admin",
      email: "kit-admin@example.test",
      role: "ADMIN",
      createdAt,
    },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin.id;
}

type RouteFn = (request: NextRequest) => Promise<Response>;
const asRoute = (fn: unknown) => fn as RouteFn;

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readKit(): Promise<RecoveryKit> {
  const { GET } = await import("@/app/api/admin/recovery-kit/route");
  const res = await asRoute(GET)(
    new NextRequest("http://localhost/api/admin/recovery-kit"),
  );
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

const shown = (kit: RecoveryKit) => ({
  entries: kit.keys.map(({ kind, id, fingerprint }) => ({
    kind,
    id,
    fingerprint,
  })),
});

async function confirm(body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/admin/recovery-kit/confirm/route");
  return POST(post("/api/admin/recovery-kit/confirm", body));
}

async function storedCopyListing(userId: string, keyIds: string[]) {
  await getPrismaClient().dataBackup.create({
    data: {
      userId,
      type: "WEEKLY_AUTO",
      data: "sealed",
      innerKeyIds: keyIds,
      innerKeyIdsRecorded: true,
    },
  });
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.$executeRaw`DELETE FROM rate_limits WHERE key LIKE 'recovery-kit-verify:%'`;
  cookieJar.clear();
  headerJar.clear();
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", "");
  vi.stubEnv("BACKUP_ENCRYPTION_PREVIOUS_KEYS", "");
  vi.stubEnv("BACKUP_S3_ENDPOINT", "");
  useKeys({ v1: KEY_A }, "v1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetCryptoCacheForTests();
});

describe("recovery kit (real Postgres)", () => {
  it("lists every key by id and fingerprint, refuses a stale confirmation, and records the right one", async () => {
    const prisma = getPrismaClient();
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", BACKUP_KEY);
    vi.stubEnv("HEALTHLOG_PLATFORM", "truenas");
    const adminId = await seedAdmin();

    const kit = await readKit();
    expect(kit.due).toBe(true);
    expect(kit.platformHint).toBe("truenas");
    expect(kit.keys.map((k) => [k.kind, k.id, k.fingerprint])).toEqual([
      ["application", "v1", getKeyFingerprint("v1")],
      [
        "backup",
        offhostKeyId(Buffer.from(BACKUP_KEY, "hex")),
        offhostKeyId(Buffer.from(BACKUP_KEY, "hex")),
      ],
      ["token", "API_TOKEN_HMAC_KEY", expect.stringMatching(/^[0-9a-f]{12}$/)],
    ]);
    const wire = JSON.stringify(kit);
    expect(wire).not.toContain(KEY_A);
    expect(wire).not.toContain(BACKUP_KEY);
    expect(wire).not.toContain(process.env.API_TOKEN_HMAC_KEY ?? "<unset>");

    const tampered = shown(kit);
    tampered.entries[0] = {
      ...tampered.entries[0],
      fingerprint: "000000000000",
    };
    const stale = await confirm(tampered);
    expect(stale.status).toBe(409);
    expect((await stale.json()).meta.errorCode).toBe("recovery.kit.stale");
    expect(await prisma.recoveryKitConfirmation.count()).toBe(0);

    const ok = await confirm(shown(kit));
    expect(ok.status).toBe(200);
    const confirmed: RecoveryKit = (await ok.json()).data;
    expect(confirmed.due).toBe(false);
    expect(confirmed.confirmedBy).toEqual({
      id: adminId,
      email: "kit-admin@example.test",
    });
    const audit = await prisma.auditLog.findFirst({
      where: { action: "recovery.kit.confirmed" },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain(KEY_A);
  });

  it("is due again after a rotation and keeps naming the retired key while a copy lists it", async () => {
    const adminId = await seedAdmin();
    await storedCopyListing(adminId, ["v1"]);
    expect((await confirm(shown(await readKit()))).status).toBe(200);

    // Rotate: v2 becomes active, v1 stays configured for the old data.
    useKeys({ v1: KEY_A, v2: KEY_B }, "v2");
    const rotated = await readKit();
    expect(rotated.due).toBe(true);
    expect(rotated.unconfirmed).toEqual([{ kind: "application", id: "v2" }]);
    expect(rotated.keys.find((k) => k.id === "v1")).toMatchObject({
      confirmed: true,
      need: { active: false, storedCopies: 1 },
    });
    expect((await confirm(shown(rotated))).status).toBe(200);
    expect((await readKit()).due).toBe(false);

    // The operator drops v1 from the server while the copy still lists it:
    // the kit keeps naming it, covered by the earlier confirmation of v1.
    useKeys({ v2: KEY_B }, "v2");
    const dropped = await readKit();
    expect(dropped.keys.find((k) => k.id === "v1")).toMatchObject({
      fingerprint: null,
      problem: "not_configured",
      confirmed: true,
    });
    expect(dropped.due).toBe(false);

    // Once no copy lists v1, it leaves the kit.
    await getPrismaClient().dataBackup.deleteMany({});
    expect((await readKit()).keys.map((k) => k.id)).not.toContain("v1");
  });

  it("names a needed key nobody confirmed in the readiness verdict", async () => {
    const adminId = await seedAdmin(new Date(Date.now() - 30 * DAY));
    useKeys({ v1: KEY_A, v2: KEY_B }, "v2");
    await storedCopyListing(adminId, ["v1"]);
    // A confirmation that covers only the new key and the token key.
    const kit = await readKit();
    await getPrismaClient().recoveryKitConfirmation.create({
      data: {
        confirmedAt: new Date(),
        entries: shown(kit).entries.filter((e) => e.id !== "v1"),
      },
    });

    const { readRecoveryReadiness } = await import("@/lib/recovery/readiness");
    const readiness = await readRecoveryReadiness();
    expect(
      readiness.signals.find((s) => s.id === "recovery_kit"),
    ).toMatchObject({
      state: "attention",
      reason: "out_of_date",
      params: { keys: "v1", count: 1 },
    });

    expect((await confirm(shown(kit))).status).toBe(200);
    const after = await readRecoveryReadiness();
    expect(after.signals.find((s) => s.id === "recovery_kit")?.state).toBe(
      "ok",
    );
  });

  it("checks a copy of each kind of key without storing it, and limits the checks", async () => {
    const prisma = getPrismaClient();
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", BACKUP_KEY);
    await seedAdmin();
    const { POST: verify } =
      await import("@/app/api/admin/recovery-kit/verify/route");
    const check = (kind: string, id: string, keyCopy: string) =>
      verify(post("/api/admin/recovery-kit/verify", { kind, id, keyCopy }));
    const backupId = offhostKeyId(Buffer.from(BACKUP_KEY, "hex"));
    const token = process.env.API_TOKEN_HMAC_KEY ?? "";
    expect(token.length).toBeGreaterThan(0);

    const good = await check("application", "v1", `${KEY_A}\n`);
    expect(good.status).toBe(200);
    expect((await good.json()).data).toEqual({
      matches: true,
      kind: "application",
      id: "v1",
    });
    expect(
      (await (await check("backup", backupId, BACKUP_KEY)).json()).data.matches,
    ).toBe(true);
    expect(
      (await (await check("token", "API_TOKEN_HMAC_KEY", token)).json()).data
        .matches,
    ).toBe(true);
    expect(
      (await (await check("application", "v1", KEY_B)).json()).data.matches,
    ).toBe(false);

    const invalid = await verify(
      post("/api/admin/recovery-kit/verify", { kind: "application", id: "v1" }),
    );
    expect(invalid.status).toBe(422);
    expect(JSON.stringify(await invalid.json())).not.toContain("issues");

    const audits = JSON.stringify(await prisma.auditLog.findMany());
    for (const secret of [KEY_A, KEY_B, BACKUP_KEY, token]) {
      expect(audits).not.toContain(secret);
    }
    expect(await prisma.recoveryKitConfirmation.count()).toBe(0);

    const limited = await check("application", "v1", KEY_A);
    expect(limited.status).toBe(429);
  });
});

describe("migration 0487", () => {
  it("carries a confirmation of the active key forward as a kit holding that key", async () => {
    const prisma = getPrismaClient();
    const adminId = await seedAdmin();
    const fingerprint = getKeyFingerprint("v1");
    // The shape before 0487: the four columns on the settings row.
    await prisma.$executeRawUnsafe(`
      ALTER TABLE app_settings
        ADD COLUMN IF NOT EXISTS encryption_key_backup_confirmed_at TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS encryption_key_backup_confirmed_key_id TEXT,
        ADD COLUMN IF NOT EXISTS encryption_key_backup_confirmed_fingerprint TEXT,
        ADD COLUMN IF NOT EXISTS encryption_key_backup_confirmed_by_user_id TEXT
    `);
    await prisma.$executeRaw`
      INSERT INTO app_settings (id, encryption_key_backup_confirmed_at,
        encryption_key_backup_confirmed_key_id,
        encryption_key_backup_confirmed_fingerprint,
        encryption_key_backup_confirmed_by_user_id)
      VALUES ('singleton', NOW(), 'v1', ${fingerprint}, ${adminId})
      ON CONFLICT (id) DO UPDATE SET
        encryption_key_backup_confirmed_at = NOW(),
        encryption_key_backup_confirmed_key_id = 'v1',
        encryption_key_backup_confirmed_fingerprint = ${fingerprint},
        encryption_key_backup_confirmed_by_user_id = ${adminId}
    `;

    const sql = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/0487_recovery_readiness/migration.sql",
      ),
      "utf8",
    );
    await prisma.$executeRawUnsafe(sql);
    // Running it again changes nothing.
    await prisma.$executeRawUnsafe(sql);

    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'app_settings'
        AND column_name LIKE 'encryption_key_backup%'
    `;
    expect(columns).toEqual([]);

    const kit = await readKit();
    expect(kit.confirmedBy?.id).toBe(adminId);
    expect(kit.keys.find((k) => k.id === "v1")?.confirmed).toBe(true);
    // The old step never covered the token key, so the kit asks for it.
    expect(kit.unconfirmed).toEqual([
      { kind: "token", id: "API_TOKEN_HMAC_KEY" },
    ]);
  });
});
