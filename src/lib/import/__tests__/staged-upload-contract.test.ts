/**
 * One error contract for every staged file upload. Each owner route is run
 * through the same refusals and must answer them alike: 413 with
 * `import.file.too_large` whether the declared length or the stream finds
 * the file too large, 422 for a body that cannot be read, 429 from the
 * bucket `import:<kind>:<account>` at five a minute, 503 without a worker or
 * a queue, 409 while an import runs, 202 for a fresh or a repeated upload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

const mocks = vi.hoisted(() => ({
  runningImportFindFirst: vi.fn(),
  checkRateLimit: vi.fn(),
  bossSend: vi.fn(),
  getGlobalBoss: vi.fn(),
  importJobCreate: vi.fn(),
  importJobFindFirst: vi.fn(),
  importJobUpdate: vi.fn(),
  streamToDisk: vi.fn(),
  unlink: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: mocks.getGlobalBoss,
}));
vi.mock("@/lib/multipart/stream-to-disk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/multipart/stream-to-disk")>()),
  streamMultipartToDisk: mocks.streamToDisk,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: mocks.unlink, rm: mocks.rm };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    importJob: {
      create: mocks.importJobCreate,
      findFirst: mocks.importJobFindFirst,
      update: mocks.importJobUpdate,
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $executeRaw: async () => 0,
        importJob: {
          findFirst: mocks.runningImportFindFirst,
          create: mocks.importJobCreate,
        },
      }),
  },
}));

import { getSession } from "@/lib/auth/session";
import {
  MultipartMalformedError,
  MultipartTooLargeError,
} from "@/lib/multipart/stream-to-disk";
import { POST as appleHealth } from "@/app/api/import/apple-health-export/route";
import { POST as healthConnect } from "@/app/api/import/health-connect-export/route";
import { POST as fit } from "@/app/api/import/fit/route";
import { POST as gadgetbridge } from "@/app/api/import/gadgetbridge/route";
import { POST as fhirBundle } from "@/app/api/import/fhir-bundle/route";

const MB = 1024 * 1024;

const ROUTES = [
  {
    name: "apple-health-export",
    post: appleHealth,
    kind: "apple_health",
    cap: 1.5 * 1024 * MB,
    queue: "apple-health-import-v2",
  },
  {
    name: "health-connect-export",
    post: healthConnect,
    kind: "health_connect",
    cap: 1024 * MB,
    queue: "health-connect-import",
  },
  { name: "fit", post: fit, kind: "fit", cap: 10 * MB, queue: "fit-import" },
  {
    name: "gadgetbridge",
    post: gadgetbridge,
    kind: "gadgetbridge",
    cap: 512 * MB,
    queue: "record-file-import",
  },
  {
    name: "fhir-bundle",
    post: fhirBundle,
    kind: "fhir_bundle",
    cap: 32 * MB,
    queue: "record-file-import",
  },
] as const;

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};
const STAGED = "/tmp/healthlog-upload-0b7f3c2a-1d4e-4f5a-9b8c-7d6e5f4a3b2c.bin";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(
    SESSION_OK as Awaited<ReturnType<typeof getSession>>,
  );
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.bossSend.mockResolvedValue("boss-job-1");
  mocks.getGlobalBoss.mockReturnValue({ send: mocks.bossSend });
  mocks.importJobCreate.mockResolvedValue({ id: "ij-1" });
  mocks.importJobFindFirst.mockResolvedValue(null);
  mocks.runningImportFindFirst.mockResolvedValue(null);
  mocks.importJobUpdate.mockResolvedValue({ id: "ij-1" });
  mocks.streamToDisk.mockResolvedValue({
    filePath: STAGED,
    bytes: 100,
    sha256: "deadbeef",
    originalFilename: "file",
    textFields: {},
  });
  mocks.unlink.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
});

function upload(name: string, contentLength?: number): NextRequest {
  return new NextRequest(`http://localhost/api/import/${name}`, {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=---x",
      ...(contentLength === undefined
        ? {}
        : { "content-length": String(contentLength) }),
    },
    body: "stub",
  });
}

async function meta(res: Response) {
  return ((await res.json()) as { meta?: Record<string, unknown> }).meta;
}

describe.each(ROUTES)("POST /api/import/$name", (route) => {
  it("spends five a minute from the bucket of the account and kind", async () => {
    await route.post(upload(route.name));
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      `import:${route.kind}:user-1`,
      5,
      60_000,
    );
    mocks.checkRateLimit.mockResolvedValue({ allowed: false });
    const res = await route.post(upload(route.name));
    expect(res.status).toBe(429);
    expect(mocks.streamToDisk).toHaveBeenCalledTimes(1);
  });

  it("refuses a declared length past the cap and the envelope reserve with 413", async () => {
    const res = await route.post(upload(route.name, route.cap + 64 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(await meta(res)).toMatchObject({
      errorCode: "import.file.too_large",
    });
    expect(mocks.streamToDisk).not.toHaveBeenCalled();
  });

  it("reads a body whose envelope alone takes it past the cap", async () => {
    const res = await route.post(upload(route.name, route.cap + 512));
    expect(res.status).toBe(202);
    expect(mocks.streamToDisk).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ maxBytes: route.cap, fieldName: "file" }),
    );
  });

  it("answers a file the stream finds too large with the same 413", async () => {
    mocks.streamToDisk.mockRejectedValue(new MultipartTooLargeError(1));
    const res = await route.post(upload(route.name));
    expect(res.status).toBe(413);
    expect(await meta(res)).toMatchObject({
      errorCode: "import.file.too_large",
    });
  });

  it("answers a body that cannot be read with 422 and the parser's reason", async () => {
    mocks.streamToDisk.mockRejectedValue(
      new MultipartMalformedError("Multipart body missing boundary parameter"),
    );
    const res = await route.post(upload(route.name));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("missing boundary");
  });

  it("answers any other failure with 422 and without its text", async () => {
    mocks.streamToDisk.mockRejectedValue(
      new Error("ENOSPC: no space left, write '/tmp/healthlog-upload-x.bin'"),
    );
    const res = await route.post(upload(route.name));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("Multipart upload failed");
  });

  it("queues a fresh upload on its own queue and answers 202", async () => {
    const res = await route.post(upload(route.name));
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual({
      jobId: "ij-1",
      status: "queued",
    });
    expect(mocks.importJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: route.kind, userId: "user-1" }),
      }),
    );
    expect(mocks.bossSend).toHaveBeenCalledWith(
      route.queue,
      expect.objectContaining({ userId: "user-1", uploadPath: STAGED }),
      expect.objectContaining({ retryLimit: 0 }),
    );
  });

  it("resolves the same bytes to the viable job", async () => {
    mocks.importJobFindFirst.mockResolvedValue({
      id: "live",
      status: "parsing",
    });
    const res = await route.post(upload(route.name));
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual({
      jobId: "live",
      status: "parsing",
      idempotent: true,
    });
    expect(mocks.unlink).toHaveBeenCalledWith(STAGED);
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });

  it("refuses while an import runs with 409 and the running job", async () => {
    mocks.runningImportFindFirst.mockResolvedValue({
      id: "ij-running",
      status: "parsing",
    });
    const res = await route.post(upload(route.name));
    expect(res.status).toBe(409);
    expect(await meta(res)).toMatchObject({
      errorCode: "import.apple_health.busy",
      jobId: "ij-running",
    });
    expect(mocks.rm).toHaveBeenCalledWith(STAGED, { force: true });
  });

  it("answers 503 without a worker and when the queue takes nothing", async () => {
    mocks.getGlobalBoss.mockReturnValue(null);
    expect((await route.post(upload(route.name))).status).toBe(503);
    mocks.getGlobalBoss.mockReturnValue({ send: mocks.bossSend });
    mocks.bossSend.mockResolvedValue(null);
    expect((await route.post(upload(route.name))).status).toBe(503);
    expect(mocks.importJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });
});
