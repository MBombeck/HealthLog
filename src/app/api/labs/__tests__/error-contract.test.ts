import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    labResult: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    biomarker: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn(),
}));
vi.mock("@/lib/logging/fire-and-forget", () => ({ fireAndForget: vi.fn() }));
vi.mock("@/lib/arrivals/emit-shared", () => ({ emitDataArrival: vi.fn() }));
vi.mock("@/lib/labs/biomarker-store", () => ({
  resolveOrMintBiomarker: vi.fn(),
}));
vi.mock("@/lib/labs/store", () => ({
  encryptNoteToBytes: vi.fn(),
  decryptNoteFromBytes: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { PUT } from "../[id]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 60_000) },
  user: { id: "u1", username: "user", role: "USER" as const },
};
const EXISTING = {
  id: "lab-1",
  userId: "u1",
  biomarkerId: null,
  analyte: "LDL",
  unit: "mg/dL",
  value: 50,
  valueText: null,
  referenceLow: 0,
  referenceHigh: 100,
  takenAt: new Date("2026-07-01T08:00:00.000Z"),
  noteEncrypted: null,
  deletedAt: null,
};

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/labs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putReq(body: unknown) {
  return new NextRequest("http://localhost/api/labs/lab-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "lab-1" }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("lab result error contract", () => {
  it("pins create validation", async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(422);
    expect((await res.json()).meta?.errorCode).toBe("labs.create.invalid");
  });

  it("pins a foreign or missing biomarker", async () => {
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(null);
    const res = await POST(
      postReq({
        biomarkerId: "bm-missing",
        value: 10,
        takenAt: "2026-07-01T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).meta?.errorCode).toBe("labs.biomarker.notFound");
  });

  it("pins update not-found", async () => {
    vi.mocked(prisma.labResult.findFirst).mockResolvedValue(null);
    const res = await PUT(putReq({ value: 10 }), ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).meta?.errorCode).toBe("labs.result.notFound");
  });

  it("pins update validation", async () => {
    vi.mocked(prisma.labResult.findFirst).mockResolvedValue(EXISTING as never);
    const res = await PUT(putReq({ takenAt: "bad-date" }), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).meta?.errorCode).toBe("labs.update.invalid");
  });

  it.each([
    {
      existing: { ...EXISTING, biomarkerId: "bm-1" },
      update: { unit: "g/L" },
      code: "labs.update.linkedFieldsImmutable",
    },
    {
      existing: { ...EXISTING, value: null, valueText: "negative" },
      update: { value: 1 },
      code: "labs.update.qualitativeExpected",
    },
    {
      existing: { ...EXISTING, value: 1, valueText: null },
      update: { valueText: "negative" },
      code: "labs.update.numericExpected",
    },
    {
      existing: { ...EXISTING, referenceLow: 0, referenceHigh: 10 },
      update: { referenceLow: 20 },
      code: "labs.update.referenceRangeInvalid",
    },
  ])("pins $code", async ({ existing, update, code }) => {
    vi.mocked(prisma.labResult.findFirst).mockResolvedValue(existing as never);
    const res = await PUT(putReq(update), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).meta?.errorCode).toBe(code);
    expect(prisma.labResult.update).not.toHaveBeenCalled();
  });
});
