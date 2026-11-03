/**
 * v1.11.0 — read-only FHIR R4 REST face.
 *
 * Asserts the searchset Bundle shape (total + self/next links + `match`
 * mode + `application/fhir+json`), `_count` clamping (≤200), paging, the
 * `fhir:read` scope wiring, and the `OperationOutcome` rate-limit envelope.
 * The shared data loader is stubbed so the test pins the REST contract, not
 * the aggregator (which has its own coverage).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(),
  isModuleEnabled: vi.fn(),
}));
vi.mock("@/lib/fhir/rest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fhir/rest")>();
  return { ...actual, loadFhirContext: vi.fn() };
});
vi.mock("@/lib/fhir/resources", () => ({
  observationsFromReportData: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET as observationGet } from "../Observation/route";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  loadFhirContext,
  MAX_COUNT,
  MAX_OFFSET,
  searchsetResponse,
} from "@/lib/fhir/rest";
import { requireModuleEnabled, isModuleEnabled } from "@/lib/modules/gate";
import { observationsFromReportData } from "@/lib/fhir/resources";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function obs(id: number) {
  return {
    resourceType: "Observation" as const,
    id: `obs-${id}`,
    status: "final" as const,
    code: { text: `m-${id}` },
    subject: { reference: "Patient/patient-1" },
  };
}

function req(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/fhir/Observation${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now(),
  } as never);
  // The doctorReport module is ON for the contract assertions below; the
  // OFF behaviour is pinned in `module-gate.test.ts`.
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(loadFhirContext).mockResolvedValue({
    data: {} as never,
    identity: { insuranceNumber: null },
    germanAtc: false,
    records: {},
  });
});

describe("GET /api/fhir/Observation — searchset", () => {
  it("returns a searchset Bundle with total, self link, and match mode", async () => {
    vi.mocked(observationsFromReportData).mockReturnValue([
      obs(1),
      obs(2),
    ] as never);

    const res = await observationGet(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/fhir+json");

    const bundle = (await res.json()) as {
      resourceType: string;
      type: string;
      total: number;
      link: Array<{ relation: string; url: string }>;
      entry: Array<{ search: { mode: string }; fullUrl: string }>;
    };
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("searchset");
    expect(bundle.total).toBe(2);
    expect(bundle.entry).toHaveLength(2);
    expect(bundle.entry[0].search.mode).toBe("match");
    expect(bundle.entry[0].fullUrl).toContain("/api/fhir/Observation/obs-1");
    expect(bundle.link.find((l) => l.relation === "self")).toBeTruthy();
    // Single page → no next link.
    expect(bundle.link.find((l) => l.relation === "next")).toBeUndefined();
  });

  it("clamps _count above the ceiling and emits a next link when more remain", async () => {
    vi.mocked(observationsFromReportData).mockReturnValue(
      Array.from({ length: 250 }, (_, i) => obs(i)) as never,
    );

    const res = await observationGet(req("?_count=9999&_offset=0"));
    const bundle = (await res.json()) as {
      total: number;
      link: Array<{ relation: string; url: string }>;
      entry: unknown[];
    };
    // 250 total, clamped page of MAX_COUNT.
    expect(bundle.total).toBe(250);
    expect(bundle.entry).toHaveLength(MAX_COUNT);
    const next = bundle.link.find((l) => l.relation === "next");
    expect(next).toBeTruthy();
    expect(next!.url).toContain(`_count=${MAX_COUNT}`);
    expect(next!.url).toContain(`_offset=${MAX_COUNT}`);
  });

  it("pages with _offset", async () => {
    vi.mocked(observationsFromReportData).mockReturnValue([
      obs(1),
      obs(2),
      obs(3),
    ] as never);
    const res = await observationGet(req("?_count=2&_offset=2"));
    const bundle = (await res.json()) as {
      total: number;
      entry: Array<{ resource: { id: string } }>;
    };
    expect(bundle.total).toBe(3);
    expect(bundle.entry).toHaveLength(1);
    expect(bundle.entry[0].resource.id).toBe("obs-3");
  });

  it("refuses only an offset a number cannot carry exactly", async () => {
    vi.mocked(observationsFromReportData).mockReturnValue([obs(1)] as never);
    for (const offset of ["9007199254740992", "1e20", "Infinity"]) {
      const res = await observationGet(req(`?_offset=${offset}`));
      expect(res.status).toBe(400);
      const outcome = (await res.json()) as {
        resourceType: string;
        issue: Array<{ code: string }>;
      };
      expect(outcome.resourceType).toBe("OperationOutcome");
      expect(outcome.issue[0].code).toBe("invalid");
    }
    // A long series pages past a hundred thousand rows, and the ceiling
    // itself still pages (an empty page past the end).
    for (const offset of ["100001", "250000", String(MAX_OFFSET)]) {
      const res = await observationGet(req(`?_offset=${offset}`));
      expect(res.status).toBe(200);
    }
  });

  it("keeps emitting next links deep into a long series, never past the ceiling", () => {
    const url = new URL("http://localhost/api/fhir/Observation");
    const deep = searchsetResponse(url, [], 300_000, 50, 150_000);
    const nextOf = async (res: Response) =>
      (
        (await res.json()) as { link: Array<{ relation: string; url: string }> }
      ).link.find((l) => l.relation === "next");
    return Promise.all([
      nextOf(deep).then((next) => {
        expect(next?.url).toContain("_offset=150050");
      }),
      nextOf(
        searchsetResponse(
          url,
          [],
          Number.POSITIVE_INFINITY,
          50,
          MAX_OFFSET - 10,
        ),
      ).then((next) => expect(next).toBeUndefined()),
    ]);
  });

  it("enforces the fhir:read scope (Bearer narrow token without it 403s)", async () => {
    // No session → Bearer path. requireAuth(FHIR_READ_SCOPE) must reject a
    // token lacking the scope; here no auth at all yields 401, proving the
    // route does gate auth before doing any work.
    vi.mocked(getSession).mockResolvedValue(null as never);
    const res = await observationGet(req());
    expect(res.status).toBe(401);
    expect(loadFhirContext).not.toHaveBeenCalled();
  });

  it("returns an OperationOutcome on rate-limit", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 999,
      resetAt: Date.now(),
    } as never);
    const res = await observationGet(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/fhir+json");
    const body = (await res.json()) as {
      resourceType: string;
      issue: Array<{ severity: string; code: string }>;
    };
    expect(body.resourceType).toBe("OperationOutcome");
    expect(body.issue[0].code).toBe("throttled");
  });
});
