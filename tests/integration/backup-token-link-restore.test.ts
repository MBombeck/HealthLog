/**
 * A backup carries the token link of an EXTERNAL reading, and a restore keeps
 * it only where it still means something (#1272).
 *
 * Tokens are not part of a backup. A reading linked to a token the restoring
 * account still holds comes back linked, so its Apple Health write-back is
 * still that token's setting; a reading whose token is gone comes back with no
 * link rather than a dangling id. The file is built by the real writer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";
import { POST as RESTORE } from "./restore-job-driver";

import { makeToken } from "../kit/factories";
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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/cache/invalidate")>();
  return { ...actual, invalidateUserData: vi.fn() };
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("restoring EXTERNAL readings", () => {
  it("keeps the link to a token the account holds and drops the rest", async () => {
    const prisma = getPrismaClient();
    const owner = await prisma.user.create({
      data: {
        username: "token-link-owner",
        email: "token-link-owner@example.test",
        role: "ADMIN",
      },
    });
    const session = await prisma.session.create({
      data: { userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const kept = await makeToken(owner, {
      permissions: [MEASUREMENTS_WRITE_SCOPE],
    });
    const gone = await makeToken(owner, {
      permissions: [MEASUREMENTS_WRITE_SCOPE],
    });
    const reading = (day: string, ingestTokenId: string | null) => ({
      userId: owner.id,
      type: "WEIGHT" as const,
      source: "EXTERNAL" as const,
      value: 80,
      unit: "kg",
      measuredAt: new Date(`${day}T06:00:00.000Z`),
      ingestTokenId,
    });
    await prisma.measurement.createMany({
      data: [
        reading("2026-10-01", kept.tokenId),
        reading("2026-10-02", gone.tokenId),
        reading("2026-10-03", null),
      ],
    });

    const { payload: built } = await buildFullBackupPayload(prisma, owner.id, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(built));
    const backup = await prisma.dataBackup.create({
      data: {
        userId: owner.id,
        type: "TOKEN_LINK_ROUND_TRIP",
        data: encrypt(JSON.stringify(parsed)),
      },
    });
    await prisma.measurement.deleteMany({ where: { userId: owner.id } });
    await prisma.apiToken.delete({ where: { id: gone.tokenId } });

    const response = await RESTORE(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof RESTORE>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    const restored = await prisma.measurement.findMany({
      where: { userId: owner.id },
      select: { measuredAt: true, ingestTokenId: true },
      orderBy: { measuredAt: "asc" },
    });
    expect(restored.map((r) => r.ingestTokenId)).toEqual([
      kept.tokenId,
      null,
      null,
    ]);
  });
});
