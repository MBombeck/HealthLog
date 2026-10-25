/**
 * The memory that the person deleted an imported document, through a backup
 * and a restore onto an instance that has never seen the account.
 *
 * Deleting an imported document leaves its source keys behind: on the
 * tombstone while it waits in Recently deleted, then in the import ledger
 * (`DocumentImportKey`) once the purge removes it. An importer re-sending
 * such a key is answered "deleted" and nothing is stored. The backup carried
 * neither, so after a restore onto a fresh instance a token importer brought
 * back every document the person had deleted on purpose.
 *
 * The file now carries the ledger, and the keys of the documents waiting in
 * Recently deleted as ledger entries (the documents themselves stay out, as
 * they always have): restored, both are answered "deleted", while a live
 * document's key stays the live document's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { encryptDocumentContent } from "@/lib/documents/store";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";
import { POST as RESTORE } from "./restore-job-driver";

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

const INSTANCE = "https://paperless.example";
const pdf = (tag: string) =>
  Buffer.from(`%PDF-1.7\n% ${tag}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedDocument(
  userId: string,
  sourceId: string,
  deletedAt: Date | null,
) {
  const bytes = pdf(sourceId);
  const { content, codec } = encryptDocumentContent(bytes);
  return getPrismaClient().inboundDocument.create({
    data: {
      userId,
      mimeType: "application/pdf",
      byteSize: bytes.byteLength,
      contentEncrypted: content,
      contentCodec: codec,
      sourceSystem: "PAPERLESS",
      sourceId,
      sourceInstance: INSTANCE,
      deletedAt,
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function importAgain(sourceId: string) {
  const { POST } = await import("@/app/api/documents/inbound/route");
  const bytes = pdf(sourceId);
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const form = new FormData();
  form.append("file", new Blob([payload]), "letter.pdf");
  form.append("sourceSystem", "PAPERLESS");
  form.append("sourceId", sourceId);
  form.append("sourceInstance", INSTANCE);
  const res = await (POST as unknown as (r: Request) => Promise<Response>)(
    new Request("http://localhost/api/documents/inbound", {
      method: "POST",
      body: form,
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe("a restore onto a fresh instance", () => {
  it("still answers a deliberately deleted import as deleted", async () => {
    const prisma = getPrismaClient();
    const owner = await prisma.user.create({
      data: {
        username: "ledger-owner",
        email: "ledger-owner@example.test",
        role: "ADMIN",
        modulePreferencesJson: { inboundDocuments: true },
      },
    });
    // Waiting in Recently deleted, with a second key remembered as an alias.
    const waiting = await seedDocument(owner.id, "412", new Date());
    await prisma.documentSourceAlias.create({
      data: {
        userId: owner.id,
        documentId: waiting.id,
        sourceSystem: "PAPERLESS",
        sourceId: "413",
        sourceInstance: INSTANCE,
      },
    });
    // Purged already: only the ledger remembers it.
    await prisma.documentImportKey.create({
      data: {
        userId: owner.id,
        sourceSystem: "PAPERLESS",
        sourceId: "500",
        sourceInstance: INSTANCE,
      },
    });
    // Live.
    await seedDocument(owner.id, "600", null);

    const { payload: built } = await buildFullBackupPayload(prisma, owner.id, {
      purpose: "disaster-recovery",
    });
    const parsed = parseBackupPayload(JSON.stringify(built));

    // The fresh instance: the account as the file brings it, nothing else.
    await prisma.documentImportKey.deleteMany({ where: { userId: owner.id } });
    await prisma.inboundDocument.deleteMany({ where: { userId: owner.id } });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: owner.id,
        type: "IMPORT_LEDGER_ROUND_TRIP",
        data: encrypt(JSON.stringify(parsed)),
      },
    });
    await signIn(owner.id);
    const response = await RESTORE(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof RESTORE>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    expect(
      (
        await prisma.documentImportKey.findMany({
          where: { userId: owner.id },
          select: { sourceSystem: true, sourceId: true, sourceInstance: true },
          orderBy: { sourceId: "asc" },
        })
      ).map((k) => [k.sourceSystem, k.sourceId, k.sourceInstance]),
    ).toEqual([
      ["PAPERLESS", "412", INSTANCE],
      ["PAPERLESS", "413", INSTANCE],
      ["PAPERLESS", "500", INSTANCE],
    ]);

    await signIn(owner.id);
    for (const sourceId of ["412", "413", "500"]) {
      const again = await importAgain(sourceId);
      expect(again.status, sourceId).toBe(200);
      expect(again.body.meta, sourceId).toEqual({
        duplicate: true,
        deleted: true,
      });
    }
    // The live document's key is still the live document's.
    const live = await importAgain("600");
    expect(live.status).toBe(200);
    expect(live.body.meta).toMatchObject({ duplicate: true });
    expect(live.body.meta.deleted).toBeUndefined();
    expect(
      await prisma.inboundDocument.count({ where: { userId: owner.id } }),
    ).toBe(1);
  });
});
