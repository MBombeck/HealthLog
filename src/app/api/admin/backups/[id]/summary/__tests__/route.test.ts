/**
 * Restore preview. A copy written with a preview is answered from it without
 * opening the copy (#1031); a copy from before previews is read whole once,
 * through the same helpers the restore uses, and what that read found is kept
 * on the row. The verdicts (schema version, keys) are taken again on every
 * read. Only a file that fails the schema is a 422 with that message; any
 * other failure is the server's, not the file's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { ZodError } from "zod/v4";

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
const updateManyMock = vi.fn();
const chunkCountMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dataBackup: {
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
      updateMany: (...a: unknown[]) => updateManyMock(...a),
    },
    dataBackupChunk: { count: (...a: unknown[]) => chunkCountMock(...a) },
  },
}));

const decryptMock = vi.fn();
// The envelope reader asks which of the stored shapes it was handed before it
// decrypts anything, so a stub of this module has to answer that too.
vi.mock("@/lib/crypto", () => ({
  decrypt: (...a: unknown[]) => decryptMock(...a),
  decryptBytes: vi.fn(),
  getConfiguredKeyIds: () => ["v1"],
  isStreamCiphertext: () => false,
  decryptStream: vi.fn(),
}));

const openSpy = vi.fn();
vi.mock("@/lib/export/stored-backup", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/export/stored-backup")>();
  return {
    ...actual,
    openStoredBackup: (...a: Parameters<typeof actual.openStoredBackup>) => {
      openSpy(...a);
      return actual.openStoredBackup(...a);
    },
  };
});

const parseMock = vi.fn();
const summarizeMock = vi.fn();
const compatibleMock = vi.fn((version: string) => version !== "99");
vi.mock("@/lib/validations/backup", () => ({
  parseBackupPayload: (...a: unknown[]) => parseMock(...a),
  // The measurements are read as a stream and counted one by one.
  backupMeasurementSchema: {
    safeParse: (value: unknown) => ({ success: true, data: value }),
  },
}));
vi.mock("@/lib/validations/backup-summary", () => ({
  summarizeBackup: (...a: unknown[]) => summarizeMock(...a),
  isCompatibleSchemaVersion: (version: string) => compatibleMock(version),
  BACKUP_SCHEMA_VERSION: "2",
}));

import { GET } from "../route";
import { storedCopyIdentity } from "@/lib/export/backup-preview";

const request = new NextRequest(
  "http://localhost/api/admin/backups/b1/summary",
);
const params = () => ({ params: Promise.resolve({ id: "b1" }) });

const ROW = {
  id: "b1",
  userId: "u1",
  data: "ciphertext",
  chunkCount: null,
  chunkStreamId: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  user: { id: "u1", username: "self-hoster" },
};

function storedPreview(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    copy: storedCopyIdentity(ROW),
    summary: {
      schemaVersion: "2",
      userId: "u1",
      exportedAt: "2026-08-01T00:00:00.000Z",
      measurements: 1_800_000,
      moodEntries: 3,
    },
    keys: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueMock.mockResolvedValue({ ...ROW, preview: null });
  updateManyMock.mockResolvedValue({ count: 1 });
  // Twelve measurements in the file: the preview counts them from the stream.
  decryptMock.mockReturnValue(
    JSON.stringify({
      measurements: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}` })),
    }),
  );
  parseMock.mockReturnValue({ schemaVersion: "2" });
  summarizeMock.mockReturnValue({
    schemaVersion: "2",
    userId: "u1",
    exportedAt: "2026-08-01T00:00:00.000Z",
    measurements: 0,
    moodEntries: 3,
  });
});

describe("GET /api/admin/backups/[id]/summary, from the stored preview", () => {
  it("answers from the preview without opening the copy", async () => {
    findUniqueMock.mockResolvedValue({ ...ROW, preview: storedPreview() });
    const res = await GET(request, params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summary).toMatchObject({
      measurements: 1_800_000,
      moodEntries: 3,
    });
    expect(body.data.owner).toBe("self-hoster");
    expect(openSpy).not.toHaveBeenCalled();
    expect(decryptMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("takes the schema verdict again against this release", async () => {
    findUniqueMock.mockResolvedValue({
      ...ROW,
      preview: storedPreview({
        summary: {
          schemaVersion: "99",
          userId: "u1",
          exportedAt: "2026-08-01T00:00:00.000Z",
          measurements: 1,
        },
      }),
    });
    const res = await GET(request, params());
    expect(res.status).toBe(422);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("takes the key verdict again against this server's keys", async () => {
    findUniqueMock.mockResolvedValue({
      ...ROW,
      preview: storedPreview({
        keys: [
          {
            keyId: "v7",
            count: 4,
            sections: ["moodEntries"],
            sample: { value: "v7.AAAA", form: "string" },
          },
          // Only in the instance settings, which the restore leaves out.
          {
            keyId: "v8",
            count: 1,
            sections: ["appSettings"],
            sample: null,
          },
        ],
      }),
    });
    const res = await GET(request, params());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      meta: { errorCode: "backup.key.missing", keyIds: ["v7"] },
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("still counts the pieces, and refuses a copy that lost one", async () => {
    const chunked = {
      ...ROW,
      data: null,
      chunkCount: 3,
      chunkStreamId: "s1",
    };
    findUniqueMock.mockResolvedValue({
      ...chunked,
      preview: storedPreview({ copy: storedCopyIdentity(chunked) }),
    });
    chunkCountMock.mockResolvedValue(3);
    expect((await GET(request, params())).status).toBe(200);

    chunkCountMock.mockResolvedValue(2);
    const res = await GET(request, params());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      meta: { errorCode: "backup.payload.undecryptable" },
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("ignores a preview that describes another copy", async () => {
    findUniqueMock.mockResolvedValue({
      ...ROW,
      preview: storedPreview({ copy: "chunks:other:3" }),
    });
    const res = await GET(request, params());
    expect(res.status).toBe(200);
    expect((await res.json()).data.summary.measurements).toBe(12);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/admin/backups/[id]/summary, a copy without a preview", () => {
  it("reads the copy once and keeps what it found on the row", async () => {
    const res = await GET(request, params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summary).toMatchObject({
      measurements: 12,
      moodEntries: 3,
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(updateManyMock).toHaveBeenCalledTimes(1));
    const [call] = updateManyMock.mock.calls[0] as [
      { where: Record<string, unknown>; data: { preview: { copy: string } } },
    ];
    // Only onto the copy it was read from.
    expect(call.where).toEqual({
      id: "b1",
      chunkStreamId: null,
      chunkCount: null,
    });
    expect(call.data.preview.copy).toBe(storedCopyIdentity(ROW));
  });

  it("shares one read between requests for the same copy", async () => {
    const [a, b] = await Promise.all([
      GET(request, params()),
      GET(request, params()),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("404s an unknown backup id", async () => {
    findUniqueMock.mockResolvedValue(null);
    await expect(GET(request, params())).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses a file it cannot decrypt with the documented 422", async () => {
    decryptMock.mockImplementation(() => {
      throw new Error("bad key");
    });
    const res = await GET(request, params());
    // Bad stored input — a key dropped from `ENCRYPTION_KEYS`, or bytes that
    // are not the ones written — and not a fault in this process, so it does
    // not answer 500 and does not reach the error reporter as one.
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      meta: { errorCode: "backup.payload.undecryptable" },
    });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("422s a file that fails schema validation", async () => {
    parseMock.mockImplementation(() => {
      throw new ZodError([]);
    });
    const res = await GET(request, params());
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(
      "Backup payload failed schema validation",
    );
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("422s a file that is not JSON", async () => {
    decryptMock.mockReturnValue("{ not json");
    const res = await GET(request, params());
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(
      "Backup payload failed schema validation",
    );
  });

  it("does not call a server failure a schema failure", async () => {
    parseMock.mockImplementation(() => {
      throw new Error("out of memory");
    });
    // Thrown to the handler, which answers 500 and reports it.
    await expect(GET(request, params())).rejects.toThrow("out of memory");
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("still answers when keeping the preview fails", async () => {
    updateManyMock.mockRejectedValue(new Error("db gone"));
    const res = await GET(request, params());
    expect(res.status).toBe(200);
  });
});
