import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * A restore writes into the account the BACKUP RECORD names, not the one the
 * encrypted payload claims.
 *
 * The route took its target from `payload.userId` — a field inside the blob —
 * while logging `backup.userId` from the row. An admin selecting one user's
 * backup could therefore write into a different account, and the audit trail
 * would record the account they thought they picked. Both values are in hand at
 * that point, so the only correct behaviour is to compare them.
 *
 * This is inside the admin privilege boundary, so it is an integrity problem
 * rather than an escalation: the operator's intent was not honoured.
 */

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  requireAdmin: vi.fn(async () => ({ user: { id: "admin-1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    dataBackup: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  toJson: <T>(value: T) => value,
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(() => "{}"),
  // The envelope reader asks which stored shape it was handed first.
  isStreamCiphertext: () => false,
  decryptStream: vi.fn(),
}));
vi.mock("@/lib/crypto/note-cipher", () => ({ encryptNote: vi.fn() }));
vi.mock("@/lib/validations/backup", () => ({
  parseBackupPayload: vi.fn(),
  isCompatibleSchemaVersion: vi.fn(() => true),
  summarizeBackup: vi.fn(() => ({})),
  // The streamed reader checks measurements one at a time; this file has none.
  BACKUP_SCHEMA_VERSION: "2",
  backupMeasurementSchema: { safeParse: vi.fn() },
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency: (fn: unknown) => fn,
  defaultUserIdResolver: vi.fn(),
}));
vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeUserMoodRollups: vi.fn(),
}));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeUserMedicationCompliance: vi.fn(),
  MEDICATION_COMPLIANCE_BACKFILL_DAYS: 30,
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeUserRollups: vi.fn(),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { parseBackupPayload } from "@/lib/validations/backup";
import { auditLog } from "@/lib/auth/audit";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/admin/backups/b-1/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The route requires a typed confirmation before it will restore anything.
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

const params = Promise.resolve({ id: "b-1" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.dataBackup.findUnique).mockResolvedValue({
    id: "b-1",
    userId: "user-A",
    data: "cipher",
    user: { id: "user-A", username: "alice" },
  } as never);
});

describe("admin backup restore — declared owner", () => {
  it("refuses when the payload names a different owner than the record", async () => {
    // The blob claims user-B; the backup row says user-A.
    vi.mocked(parseBackupPayload).mockReturnValue({
      userId: "user-B",
    } as never);

    const res = await (
      POST as unknown as (r: NextRequest, c: unknown) => Promise<Response>
    )(request(), { params });

    expect(res.status).toBe(409);
    // The restore must not have gone looking for the claimed user at all.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    // And the refusal is recorded with BOTH ids, so the attempt is reviewable.
    expect(auditLog).toHaveBeenCalledWith(
      "admin.backups.restore.failed",
      expect.objectContaining({
        details: expect.objectContaining({
          reason: "owner_mismatch",
          ownerId: "user-A",
          declaredOwnerId: "user-B",
        }),
      }),
    );
  });

  it("proceeds past the check when the two agree", async () => {
    vi.mocked(parseBackupPayload).mockReturnValue({
      userId: "user-A",
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);

    const res = await (
      POST as unknown as (r: NextRequest, c: unknown) => Promise<Response>
    )(request(), { params });

    // Reaching the owner lookup proves the mismatch branch did not fire; this
    // case then fails on the deleted-user branch, which is the next guard.
    expect(prisma.user.findUnique).toHaveBeenCalled();
    expect(res.status).not.toBe(409);
  });
});
