import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { formatMeasurementsForExport, toCSV } from "@/lib/export";
import { MEASUREMENT_EXPORT_PAGE_SIZE } from "@/lib/export/paged-measurements";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/geo", () => ({ lookupIpLocation: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn().mockResolvedValue("UTC"),
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn().mockResolvedValue(null),
}));

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";
import { GET } from "../measurements/route";
import { GET as GET_LEGACY } from "../route";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", role: "USER" as const },
};

function request(): NextRequest {
  return new NextRequest(
    "http://localhost/api/export/measurements?granularity=raw",
    { method: "GET" },
  );
}

function legacyRequest(): NextRequest {
  return new NextRequest(
    "http://localhost/api/export?format=json&type=measurements",
    { method: "GET" },
  );
}

function measurement(index: number) {
  return {
    id: `m-${String(index).padStart(5, "0")}`,
    type: index % 2 === 0 ? "WEIGHT" : "HEART_RATE",
    value: index + 0.25,
    unit: index % 2 === 0 ? "kg" : "bpm",
    measuredAt: new Date(Date.UTC(2026, 6, 21, 12, 0, 0) - index * 1_000),
    source: "MANUAL",
    notes: index === 1 ? 'comma, quote " and\nnewline' : null,
    notesEncrypted: null,
    glucoseContext: null,
    sleepStage: null,
    deviceType: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 3_600_000,
  });
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    glucoseUnit: "mg/dL",
  } as never);
});

describe("GET /api/export/measurements streaming", () => {
  it("does not audit a failed authorization", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("persists the audit event before returning the streaming response", async () => {
    let persistAudit!: () => void;
    const auditPersistence = new Promise<void>((resolve) => {
      persistAudit = resolve;
    });
    let markAuditStarted: (() => void) | undefined;
    const auditStarted = new Promise<void>((resolve) => {
      markAuditStarted = resolve;
    });
    vi.mocked(auditLog).mockImplementationOnce(() => {
      markAuditStarted?.();
      return auditPersistence;
    });
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);

    const responsePromise = GET(request());
    const firstSettled = await Promise.race([
      responsePromise.then(() => "response" as const),
      auditStarted.then(() => "audit" as const),
    ]);

    persistAudit();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(firstSettled).toBe("audit");
    expect(auditLog).toHaveBeenCalledTimes(1);
    await response.body?.cancel();
  });

  it("streams exact CSV across a keyset page boundary", async () => {
    const firstPage = Array.from(
      { length: MEASUREMENT_EXPORT_PAGE_SIZE },
      (_, index) => measurement(index),
    );
    const finalPage = [measurement(MEASUREMENT_EXPORT_PAGE_SIZE)];
    vi.mocked(prisma.measurement.findMany)
      .mockResolvedValueOnce(firstPage as never)
      .mockResolvedValueOnce(finalPage as never);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledTimes(1);

    const body = await response.text();
    const allRows = [...firstPage, ...finalPage];
    const expected = toCSV(
      formatMeasurementsForExport(allRows, "UTC", {
        granularity: "raw",
        sleepTz: "UTC",
        sourcePriorityJson: null,
        glucoseUnit: "mg/dL",
      }),
    );

    expect(body).toBe(expected);
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(2);
    expect(auditLog).toHaveBeenCalledWith("user.export.measurements", {
      userId: "user-1",
      ipAddress: null,
      details: {
        outcome: "attempted",
        since: null,
        until: null,
      },
    });
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it("propagates a later page failure through the response body", async () => {
    const failure = new Error("measurement page failed");
    const firstPage = Array.from(
      { length: MEASUREMENT_EXPORT_PAGE_SIZE },
      (_, index) => measurement(index),
    );
    vi.mocked(prisma.measurement.findMany)
      .mockResolvedValueOnce(firstPage as never)
      .mockRejectedValueOnce(failure);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(1);
    await expect(response.text()).rejects.toThrow("measurement page failed");
    expect(auditLog).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/export legacy measurement streaming", () => {
  it("does not audit a failed authorization", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const response = await GET_LEGACY(legacyRequest());

    expect(response.status).toBe(401);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("persists the audit event before returning the streaming response", async () => {
    let persistAudit!: () => void;
    const auditPersistence = new Promise<void>((resolve) => {
      persistAudit = resolve;
    });
    let markAuditStarted: (() => void) | undefined;
    const auditStarted = new Promise<void>((resolve) => {
      markAuditStarted = resolve;
    });
    vi.mocked(auditLog).mockImplementationOnce(() => {
      markAuditStarted?.();
      return auditPersistence;
    });
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);

    const responsePromise = GET_LEGACY(legacyRequest());
    const firstSettled = await Promise.race([
      responsePromise.then(() => "response" as const),
      auditStarted.then(() => "audit" as const),
    ]);

    persistAudit();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(firstSettled).toBe("audit");
    expect(auditLog).toHaveBeenCalledTimes(1);
    await response.body?.cancel();
  });

  it("frames exact JSON while pulling later measurement pages from the body", async () => {
    const firstPage = Array.from(
      { length: MEASUREMENT_EXPORT_PAGE_SIZE },
      (_, index) => measurement(index),
    );
    const finalPage = [measurement(MEASUREMENT_EXPORT_PAGE_SIZE)];
    vi.mocked(prisma.measurement.findMany)
      .mockResolvedValueOnce(firstPage as never)
      .mockResolvedValueOnce(finalPage as never);

    const response = await GET_LEGACY(legacyRequest());
    expect(response.status).toBe(200);
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledTimes(1);

    const body = await response.text();
    const records = formatMeasurementsForExport(
      [...firstPage, ...finalPage],
      "UTC",
      {
        sleepTz: "UTC",
        sourcePriorityJson: null,
        glucoseUnit: "mg/dL",
      },
    );
    expect(body).toBe(JSON.stringify({ data: { measurements: records } }));
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(2);
    expect(auditLog).toHaveBeenCalledWith("export.download", {
      userId: "user-1",
      ipAddress: null,
      details: {
        format: "json",
        type: "measurements",
        outcome: "attempted",
      },
    });
    expect(auditLog).toHaveBeenCalledTimes(1);
  });
});
