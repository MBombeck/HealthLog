/**
 * v1.7.0 — POST /api/export/health-record unit coverage.
 *
 * Mock-based (no testcontainers): pins the route contract — strict Zod
 * rejection paths (422 via returnAllZodIssues), rate-limit (429), the
 * three format outputs (PDF magic bytes, application/fhir+json valid
 * Bundle, application/zip), and that the user is narrowed from the
 * session (never the body).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/geo", () => ({ lookupIpLocation: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitStructuredLog: vi.fn() }));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn().mockResolvedValue("Europe/Berlin"),
}));

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  user: { id: "user-1", email: "test@example.com", role: "USER" },
} as const;

function mkReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/export/health-record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 3_600_000,
  } as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  // First findUnique = aggregator profile select; second = route KVNR select.
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    username: "sample",
    dateOfBirth: null,
    gender: null,
    heightCm: null,
    glucoseUnit: null,
    thresholdsJson: null,
    fullName: null,
    insurerName: null,
    insuranceNumberEncrypted: null,
    insightsCachedText: null,
  } as never);
});

describe("POST /api/export/health-record — validation", () => {
  it("rejects an unknown format with 422", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "xml" }));
    expect(res.status).toBe(422);
  });

  it("rejects a missing format with 422", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({}));
    expect(res.status).toBe(422);
  });

  it("rejects a userId smuggled into the body with 422", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "pdf", userId: "user-2" }));
    expect(res.status).toBe(422);
  });

  it("returns 429 when the export rate limit is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 3_600_000,
    } as never);
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir" }));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/export/health-record — outputs", () => {
  it("format=fhir returns a valid FHIR document Bundle", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/fhir+json");
    const bundle = await res.json();
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("document");
    expect(bundle.entry[0].resource.resourceType).toBe("Composition");
  });

  it("format=pdf returns a PDF with the %PDF- magic bytes", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "pdf" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("format=package returns a zip", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "package" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    // ZIP local-file-header magic: PK\x03\x04
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("scopes the aggregator measurement read to the session user", async () => {
    const { POST } = await import("../route");
    await POST(mkReq({ format: "fhir", userId: "user-2" } as never));
    // userId smuggle is rejected above; here we confirm the read uses the
    // session user, not anything from the body, for a clean payload.
    await POST(mkReq({ format: "fhir" }));
    expect(prisma.measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", deletedAt: null }),
      }),
    );
  });
});
