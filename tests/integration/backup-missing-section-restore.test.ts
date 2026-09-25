/**
 * A file that claims a section it does not carry is refused whole (#237).
 *
 * The restore's first act is to delete the class of records it is about to
 * rebuild. So a payload whose documents section is simply absent does not
 * "restore everything else": it empties the vault, reports success, and leaves
 * the operator to discover the hole later. The maintainer's decision is to
 * refuse the file instead — above the transaction, like the metadata-only
 * check beside it, so the account survives the refusal.
 *
 * The hard part is not the refusal. It is the boundary, and both halves are
 * asserted here against the real route and real rows:
 *
 *   MISSING — the manifest says the file carries documents, and the key is not
 *   there. Refused, named, nothing deleted.
 *
 *   DECLARED OMITTED — the manifest says the file does NOT carry the
 *   mental-health screeners or the consent receipts, and the keys are not
 *   there. That is what every portable export writes, on purpose, and it has to
 *   restore. The two cases below are the same builder, the same account and the
 *   same deleted-key trick; the only difference is what the manifest said, which
 *   is exactly the claim being made.
 *
 * Mutation check: drop the `included === "omitted"` skip in
 * `findMissingBackupSections` and the second case goes red. Move the refusal
 * below the `prisma.$transaction(...)` call and the first case's surviving-rows
 * assertions go red while its status assertion stays green — which is why the
 * rows are asserted separately rather than trusted to follow from the status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { POST } from "./restore-job-driver";
import { invalidateUserData } from "@/lib/cache/invalidate";

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

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  vi.mocked(invalidateUserData).mockClear();
});

function makeRequest(id: string) {
  return new Request(`http://localhost/api/admin/backups/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

/**
 * An admin account with one measurement and nothing else, signed in.
 *
 * The measurement is the witness. It references nothing the refusal is about,
 * so it can only be lost to the wipe — which is what tells a refused restore
 * apart from a destroyed account.
 */
async function seedOwner(username: string) {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: { username, email: `${username}@example.test`, role: "ADMIN" },
  });
  const session = await prisma.session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  await prisma.measurement.create({
    data: {
      userId: owner.id,
      type: "WEIGHT",
      value: 79.2,
      unit: "kg",
      source: "MANUAL",
      measuredAt: new Date("2026-07-11T06:15:00.000Z"),
    },
  });
  return owner;
}

/**
 * A real portable export of that account, with the named keys cut out of the
 * JSON before it is sealed.
 *
 * Cutting them from the RAW object rather than from a parsed payload is the
 * whole point: every section in `backupPayloadSchema` carries `.default([])`,
 * so a payload that has been through the schema no longer knows the difference
 * between a section that was absent and one that was empty.
 */
async function sealPortableWithout(
  ownerId: string,
  keys: string[],
): Promise<{ backupId: string; manifest: Record<string, unknown> }> {
  const prisma = getPrismaClient();
  // No `purpose`, so the builder takes the portable branch — the file a person
  // gets from "export my data".
  const { payload } = await buildFullBackupPayload(prisma, ownerId);
  const raw = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  for (const key of keys) delete raw[key];

  const backup = await prisma.dataBackup.create({
    data: {
      userId: ownerId,
      type: "MISSING_SECTION_RESTORE",
      data: encrypt(JSON.stringify(raw)),
    },
  });
  return {
    backupId: backup.id,
    manifest: raw.manifest as Record<string, unknown>,
  };
}

async function restore(backupId: string) {
  return await POST(
    makeRequest(backupId) as unknown as Parameters<typeof POST>[0],
    { params: Promise.resolve({ id: backupId }) },
  );
}

describe("a backup whose manifest claims a section the file does not carry", () => {
  it("refuses the whole file, names the section, and changes nothing", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner("missing-section-owner");
    const { backupId, manifest } = await sealPortableWithout(owner.id, [
      "documents",
    ]);

    // Prove the premise rather than assume it: the file still SAYS it carries
    // documents. Without this the test would keep passing if the builder ever
    // stopped writing the manifest entry.
    expect(
      (manifest.documents as { included?: string } | undefined)?.included,
    ).toBe("metadata-only");

    const response = await restore(backupId);

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: string;
      meta?: { errorCode?: string; sections?: string[] };
    };
    expect(
      body.error,
      "the message names the section, so the operator can act on it",
    ).toContain("documents");
    expect(
      body.error,
      "and says the account is intact, because that is the decision they need",
    ).toContain("Nothing was changed");
    expect(body.meta?.errorCode).toBe("backup.section.missing");
    expect(body.meta?.sections).toEqual(["documents"]);

    // The refusal is only worth anything above the wipe.
    expect(
      await prisma.measurement.count({ where: { userId: owner.id } }),
      "a refused restore must not have run the wipe",
    ).toBe(1);
    // A second, independent witness: the invalidation only fires at the end of
    // a restore that actually happened.
    expect(vi.mocked(invalidateUserData)).not.toHaveBeenCalled();

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.backups.restore.failed" },
      orderBy: { createdAt: "desc" },
    });
    const details = JSON.parse(auditRow.details ?? "{}") as {
      reason?: string;
      sections?: string[];
    };
    expect(details.reason).toBe("section_missing");
    expect(details.sections).toEqual(["documents"]);
  });

  it("restores a file whose manifest DECLARES the same keys omitted", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner("declared-omission-owner");
    // The two sections a portable export leaves out on purpose, cut from the
    // file exactly the way `documents` was cut above.
    const { backupId, manifest } = await sealPortableWithout(owner.id, [
      "mentalHealthAssessments",
      "consentReceipts",
    ]);

    expect(
      (manifest.mentalHealth as { included?: string } | undefined)?.included,
    ).toBe("omitted");
    expect(
      (manifest.consent as { included?: string } | undefined)?.included,
    ).toBe("omitted");

    const response = await restore(backupId);

    expect(
      response.status,
      "a declared omission is not a missing section",
    ).toBe(200);
    const body = (await response.json()) as { data: { restored: boolean } };
    expect(body.data.restored).toBe(true);
    // The restore genuinely ran: the measurement came back out of the file it
    // was exported into, and the cache was evicted.
    expect(
      await prisma.measurement.count({ where: { userId: owner.id } }),
    ).toBe(1);
    expect(vi.mocked(invalidateUserData)).toHaveBeenCalledWith(owner.id);
  });
});
