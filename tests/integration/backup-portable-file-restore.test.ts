/**
 * A portable file is refused BEFORE the wipe, and the account survives it.
 *
 * `buildFullBackupPayload` has two modes. Disaster-recovery carries a
 * document's stored bytes as base64. Portable — what the two user-facing export
 * routes produce — carries metadata only: title, kind, size, dates, a decrypted
 * summary. The bytes stay on the server.
 *
 * Both files are valid. `contentEncrypted` is optional in
 * `backupPayloadSchema` precisely because a portable file honestly has none, so
 * both pass validation and both are accepted by
 * `POST /api/admin/backups/upload`, which checks the schema version and the
 * owner and nothing about the purpose. An operator can therefore point the
 * restore at the file a user downloaded from "export my data".
 *
 * `InboundDocument.contentEncrypted` is `Bytes` and NOT NULL, so there is no
 * honest metadata-only row to write, and the restore refuses the file rather
 * than inventing empty content. That refusal is deliberate and documented at
 * the guard. What was NOT pinned anywhere is the half that makes it
 * survivable: the check runs before the `$transaction` that wipes the account.
 *
 * That ordering is the whole difference between a refused restore and a
 * destroyed account, and it is the kind of thing a later edit moves without
 * noticing — the guard reads like input validation, and input validation
 * drifts toward wherever the value is first used. If it ever ends up below the
 * wipe, the operator loses everything to a file the server was always going to
 * reject. The `!` assertions on `document.contentEncrypted` in the restore body
 * are safe only because this guard stands above them.
 *
 * So this test asserts, against ROWS and against the real route:
 *
 *   - the refusal happens, with 422 and the document named in the message,
 *   - every row the account had is still there afterwards,
 *   - the refusal is on the record, so it is not a silent no-op.
 *
 * Mutation check: move the `incompleteDocument` check below the
 * `prisma.$transaction(...)` call and this fails on the measurement count. The
 * status assertion alone stays green, which is why the surviving rows are
 * asserted separately rather than trusted to follow from the status.
 *
 * Not asserted here, deliberately: whether refusing the WHOLE file for one
 * metadata-only document is the right trade. Skipping the documents and
 * restoring the other hundred models is the shape the retired-catalogue-key
 * work settled on elsewhere in this same route, and it would give an operator
 * whose only file is the portable export something back instead of nothing.
 * That is a change to what a restore means, not a defect in what it does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt, encryptBytes } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";
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

describe("restoring a portable backup that carries no document bytes", () => {
  it("refuses the file and leaves the account exactly as it was", async () => {
    const prisma = getPrismaClient();

    const owner = await prisma.user.create({
      data: {
        username: "portable-restore-owner",
        email: "portable-restore-owner@example.test",
        role: "ADMIN",
      },
    });
    const session = await prisma.session.create({
      data: { userId: owner.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    // Carries no document reference at all, so it can only be lost to the wipe.
    // This is the row that tells a refusal apart from a destroyed account.
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

    const document = await prisma.inboundDocument.create({
      data: {
        userId: owner.id,
        kind: "LAB_RESULT",
        title: "Blood panel, July",
        filename: "panel.pdf",
        mimeType: "application/pdf",
        byteSize: 4096,
        contentEncrypted: new Uint8Array(
          encryptBytes(Buffer.from("%PDF-1.4 fixture")),
        ),
        contentCodec: "bytes-v1",
        status: "STORED",
      },
    });

    /* ── the portable file, exactly as the export route writes it ──────── */

    // No `purpose`, so the builder takes the metadata-only branch. The point of
    // the fixture is that this file is VALID, not corrupt.
    const { payload: built } = await buildFullBackupPayload(prisma, owner.id);
    const parsed = parseBackupPayload(JSON.stringify(built));

    // Prove the premise rather than assume it. If the portable mode ever starts
    // carrying bytes, this test would otherwise keep passing while testing
    // nothing at all.
    const carried = parsed.documents.find((d) => d.id === document.id);
    expect(carried, "the portable file describes the document").toBeDefined();
    expect(
      carried?.contentEncrypted,
      "the portable file carries no bytes for it",
    ).toBeUndefined();

    const backup = await prisma.dataBackup.create({
      data: {
        userId: owner.id,
        type: "PORTABLE_FILE_RESTORE",
        data: encrypt(JSON.stringify(parsed)),
      },
    });

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );

    /* ── the refusal ───────────────────────────────────────────────────── */

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(
      body.error,
      "the message names the document, so the operator can act on it",
    ).toContain(document.id);

    /* ── and the account is untouched ──────────────────────────────────── */

    expect(
      await prisma.measurement.count({ where: { userId: owner.id } }),
      "a refused restore must not have run the wipe",
    ).toBe(1);
    expect(
      await prisma.inboundDocument.count({ where: { userId: owner.id } }),
    ).toBe(1);

    // The cache invalidation fires at the end of a successful restore. Its
    // absence is a second, independent witness that nothing was rewritten.
    expect(vi.mocked(invalidateUserData)).not.toHaveBeenCalled();

    /* ── and it is on the record ───────────────────────────────────────── */

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: "admin.backups.restore.failed" },
      orderBy: { createdAt: "desc" },
    });
    const details = JSON.parse(auditRow.details ?? "{}") as {
      reason?: string;
      documentId?: string;
    };
    expect(details.reason).toBe("document_ciphertext_missing");
    expect(details.documentId).toBe(document.id);
  });
});
