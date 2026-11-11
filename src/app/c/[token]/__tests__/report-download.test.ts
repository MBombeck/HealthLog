/**
 * The two machine-format downloads on a share link.
 *
 * A practice opens the link, unlocks it, and saves the file into their system.
 * That is what the removed FHIR toggle promised and never served. The gate has
 * to be the document route's, step for step — the same live check, the same
 * token-scoped unlock cookie, a rate limit before any aggregation, and the same
 * blunt 404 for every miss class, so a probe cannot tell "no such link" from
 * "revoked" from "documents-only".
 *
 * The load-bearing scope property: the download resolves the SAME frozen
 * selection the page renders from, so it can never be wider than the page.
 *
 * Mutation checks:
 *   - remove the unlock-cookie check in `resolveShareReportDownload` →
 *     "refuses a protected link without the unlock cookie" goes red.
 *   - remove the rate-limit check → "refuses over the rate limit" goes red.
 *   - drop the `view.documentOnly` guard → "refuses a documents-only link"
 *     goes red.
 *   - change the bucket key to the document route's `share-documents:` →
 *     "uses its own rate bucket" goes red.
 *   - drop the `auditLog` call → "records an audit row per download" goes red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/clinician-share/resolve-share-token", () => ({
  resolveShareGateState: vi.fn(),
  resolveShareToken: vi.fn(),
}));
vi.mock("@/lib/clinician-share/unlock-cookie", () => ({
  unlockCookieName: (hash: string) => `hls_unlock_${hash}`,
  verifyUnlockValue: vi.fn(),
}));
vi.mock("@/lib/clinician-share/share-view-data", () => ({
  loadShareViewData: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/geo", () => ({ lookupIpLocation: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/tz/resolver", () => ({ resolveUserTimezone: vi.fn() }));
// Wraps rather than replaces: the real renderer still runs, so the route is
// exercised end to end, and the options it was handed stay observable.
const pdfOptionsSeen: Array<Record<string, unknown>> = [];
vi.mock("@/lib/doctor-report-pdf-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/doctor-report-pdf-core")>();
  return {
    ...actual,
    renderDoctorReportPdfBytes: (
      data: Parameters<typeof actual.renderDoctorReportPdfBytes>[0],
      options: Parameters<typeof actual.renderDoctorReportPdfBytes>[1],
    ) => {
      pdfOptionsSeen.push(options as unknown as Record<string, unknown>);
      return actual.renderDoctorReportPdfBytes(data, options);
    },
  };
});
vi.mock("@/lib/logging/transports", () => ({ emitStructuredLog: vi.fn() }));
vi.mock("@/lib/i18n/server-translator", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/i18n/server-translator")>();
  return actual;
});

import { cookies } from "next/headers";
import {
  resolveShareGateState,
  resolveShareToken,
} from "@/lib/clinician-share/resolve-share-token";
import { verifyUnlockValue } from "@/lib/clinician-share/unlock-cookie";
import { loadShareViewData } from "@/lib/clinician-share/share-view-data";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import { prisma } from "@/lib/db";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { selectionFromLeaves } from "@/lib/report-selection/selection";
import type { DoctorReportData } from "@/lib/doctor-report-data";

const TOKEN = "hls_deadbeef";

function report(): DoctorReportData {
  return {
    period: {
      days: 30,
      since: "2026-01-01",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-31T00:00:00.000Z",
    },
    patient: {
      name: null,
      dateOfBirth: null,
      gender: null,
      heightCm: null,
    },
    practiceName: null,
    measurements: {},
    stats: { WEIGHT: { avg: 80, min: 78, max: 82, count: 4, latest: 79 } },
    glucoseStats: {},
    glucoseRanges: {},
    glucoseClinical: computeGlucoseClinicalMetrics([], {
      now: new Date("2026-01-31T00:00:00.000Z"),
    }),
    glucoseUnit: "mg/dL",
    bmi: null,
    compliance: {},
    medications: [],
    mood: null,
    wellnessScores: null,
  } as DoctorReportData;
}

function req(): Request {
  return new Request(`http://localhost/c/${TOKEN}/fhir`);
}

const params = { params: Promise.resolve({ token: TOKEN }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveShareGateState).mockResolvedValue({
    tokenHash: "hash-1",
    passphraseHash: "pass-hash",
  } as never);
  vi.mocked(cookies).mockResolvedValue({
    get: () => ({ value: "unlock-value" }),
  } as never);
  vi.mocked(verifyUnlockValue).mockReturnValue(true);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: new Date(),
  } as never);
  vi.mocked(resolveShareToken).mockResolvedValue({
    shareLinkId: "link-1",
    ownerUserId: "owner-1",
  } as never);
  vi.mocked(loadShareViewData).mockResolvedValue({
    report: report(),
    selection: selectionFromLeaves(["WEIGHT"]),
    documents: [],
    documentOnly: false,
  } as never);
  // West of UTC on purpose. Berlin is the display fallback, so a Berlin
  // fixture cannot tell a resolved timezone apart from a forgotten one.
  vi.mocked(resolveUserTimezone).mockResolvedValue("America/Los_Angeles");
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    timeFormat: "H24",
  } as never);
});

describe("GET /c/{token}/fhir", () => {
  it("serves the link's frozen scope as a document Bundle", async () => {
    const { GET } = await import("../fhir/route");
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/fhir+json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bundle = (await res.json()) as {
      resourceType: string;
      type: string;
    };
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("document");
  });

  it("carries no Coverage — the insurance leaf cannot reach this path", async () => {
    const { GET } = await import("../fhir/route");
    const res = await GET(req(), params);
    const bundle = (await res.json()) as {
      entry: { resource: { resourceType: string } }[];
    };
    expect(bundle.entry.map((e) => e.resource.resourceType)).not.toContain(
      "Coverage",
    );
  });

  it("refuses a protected link without the unlock cookie", async () => {
    vi.mocked(verifyUnlockValue).mockReturnValue(false);
    const { GET } = await import("../fhir/route");
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
    expect(loadShareViewData).not.toHaveBeenCalled();
  });

  it("refuses an unknown, revoked or expired token with the same flat 404", async () => {
    vi.mocked(resolveShareGateState).mockResolvedValue(null as never);
    const { GET } = await import("../fhir/route");
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("refuses a documents-only link even if a report came back with it", async () => {
    // The flag is authoritative on its own. `loadShareViewData` returns a null
    // report alongside it today, so the two conditions agree — this fixture
    // separates them so the flag's own check is provably load-bearing rather
    // than carried by its neighbour.
    vi.mocked(loadShareViewData).mockResolvedValue({
      report: report(),
      selection: selectionFromLeaves(["WEIGHT"]),
      documents: [],
      documentOnly: true,
    } as never);
    const { GET } = await import("../fhir/route");
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
  });

  it("refuses a link that produced no report", async () => {
    vi.mocked(loadShareViewData).mockResolvedValue({
      report: null,
      selection: selectionFromLeaves([]),
      documents: [],
      documentOnly: false,
    } as never);
    const { GET } = await import("../fhir/route");
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
  });

  it("refuses over the rate limit, before any aggregation", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 21,
      resetAt: new Date(),
    } as never);
    const { GET } = await import("../fhir/route");
    const res = await GET(req(), params);
    expect(res.status).toBe(429);
    expect(loadShareViewData).not.toHaveBeenCalled();
  });

  it("uses its own rate bucket, not the document route's", async () => {
    const { GET } = await import("../fhir/route");
    await GET(req(), params);
    // Generating a bundle is far more expensive than serving a stored blob and
    // must not share a budget with it.
    expect(checkRateLimit).toHaveBeenCalledWith(
      "report-download:hash-1",
      20,
      60 * 60 * 1000,
    );
  });

  it("records an audit row per download, scoped to the owner", async () => {
    const { GET } = await import("../fhir/route");
    await GET(req(), params);
    expect(auditLog).toHaveBeenCalledWith(
      "share-link.report.download",
      expect.objectContaining({
        userId: "owner-1",
        details: expect.objectContaining({
          shareLinkId: "link-1",
          format: "fhir",
          leafCount: 1,
        }),
      }),
    );
  });
});

describe("GET /c/{token}/report.pdf", () => {
  it("serves the link's frozen scope as a PDF", async () => {
    const { GET } = await import("../report.pdf/route");
    const res = await GET(
      new Request(`http://localhost/c/${TOKEN}/report.pdf`),
      params,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("prints the owner's day, not the display default", async () => {
    // The defect: the route handed the renderer no timezone at all, so it fell
    // back to the display default. A reading is dated by the day it was where
    // the person lives, and a practice filing the PDF beside the page it came
    // from must not find two different dates for one reading.
    pdfOptionsSeen.length = 0;
    const { GET } = await import("../report.pdf/route");
    await GET(new Request(`http://localhost/c/${TOKEN}/report.pdf`), params);

    expect(pdfOptionsSeen).toHaveLength(1);
    expect(
      pdfOptionsSeen[0].userTz,
      "the renderer was handed no owner timezone — it will fall back to the display default",
    ).toBe("America/Los_Angeles");
    expect(
      pdfOptionsSeen[0].timeFormat,
      "the owner's clock preference did not reach the renderer",
    ).toBe("H24");
  });

  it("falls back to AUTO when the owner row carries no clock preference", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    pdfOptionsSeen.length = 0;
    const { GET } = await import("../report.pdf/route");
    const res = await GET(
      new Request(`http://localhost/c/${TOKEN}/report.pdf`),
      params,
    );
    expect(res.status).toBe(200);
    expect(pdfOptionsSeen[0].timeFormat).toBe("AUTO");
  });

  it("runs the same gate as the bundle beside it", async () => {
    vi.mocked(verifyUnlockValue).mockReturnValue(false);
    const { GET } = await import("../report.pdf/route");
    const res = await GET(
      new Request(`http://localhost/c/${TOKEN}/report.pdf`),
      params,
    );
    expect(res.status).toBe(404);
  });

  it("records its own format in the audit row", async () => {
    const { GET } = await import("../report.pdf/route");
    await GET(new Request(`http://localhost/c/${TOKEN}/report.pdf`), params);
    expect(auditLog).toHaveBeenCalledWith(
      "share-link.report.download",
      expect.objectContaining({
        details: expect.objectContaining({ format: "pdf" }),
      }),
    );
  });
});
