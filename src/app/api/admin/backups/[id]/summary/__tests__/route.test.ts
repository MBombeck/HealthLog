/**
 * v1.37.20 — restore preview: the summary read decrypts and validates the
 * stored file through the SAME helpers the restore uses, and only ever
 * reads. Watched red: written against the route before its annotate landed;
 * the not-found and decrypt-failure arms were asserted first.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAdmin: vi.fn(async () => ({ user: { id: "admin-1" } })),
  HttpError: class HttpError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

const findUniqueMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dataBackup: { findUnique: (...a: unknown[]) => findUniqueMock(...a) },
  },
}));

const decryptMock = vi.fn();
// The envelope reader asks which of the stored shapes it was handed before it
// decrypts anything, so a stub of this module has to answer that too.
vi.mock("@/lib/crypto", () => ({
  decrypt: (...a: unknown[]) => decryptMock(...a),
  isStreamCiphertext: () => false,
  decryptStream: vi.fn(),
}));

const parseMock = vi.fn();
const summarizeMock = vi.fn();
vi.mock("@/lib/validations/backup", () => ({
  parseBackupPayload: (...a: unknown[]) => parseMock(...a),
  summarizeBackup: (...a: unknown[]) => summarizeMock(...a),
  isCompatibleSchemaVersion: vi.fn(() => true),
}));

import { GET } from "../route";

const request = new NextRequest(
  "http://localhost/api/admin/backups/b1/summary",
);
const params = { params: Promise.resolve({ id: "b1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueMock.mockResolvedValue({
    id: "b1",
    userId: "u1",
    data: "ciphertext",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    user: { id: "u1", username: "self-hoster" },
  });
  decryptMock.mockReturnValue("{}");
  parseMock.mockReturnValue({ schemaVersion: 3 });
  summarizeMock.mockReturnValue({ measurements: 12, moodEntries: 3 });
});

describe("GET /api/admin/backups/[id]/summary", () => {
  it("answers the file's counts without writing anything", async () => {
    const res = await GET(request, params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summary).toEqual({ measurements: 12, moodEntries: 3 });
    expect(body.data.owner).toBe("self-hoster");
  });

  it("404s an unknown backup id", async () => {
    findUniqueMock.mockResolvedValue(null);
    await expect(GET(request, params)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a file it cannot decrypt with the documented 422", async () => {
    decryptMock.mockImplementation(() => {
      throw new Error("bad key");
    });
    const res = await GET(request, params);
    // Bad stored input — a key dropped from `ENCRYPTION_KEYS`, or bytes that
    // are not the ones written — and not a fault in this process, so it does
    // not answer 500 and does not reach the error reporter as one.
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      meta: { errorCode: "backup.payload.undecryptable" },
    });
  });

  it("422s a file that fails schema validation", async () => {
    parseMock.mockImplementation(() => {
      throw new Error("nope");
    });
    const res = await GET(request, params);
    expect(res.status).toBe(422);
  });
});
