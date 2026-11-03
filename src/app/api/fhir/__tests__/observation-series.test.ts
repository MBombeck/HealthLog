/**
 * v1.44 — the Observation search's two answers. Without `date` the route
 * serves the snapshot exactly as before (the whole-record loader runs, the
 * series loader does not); with `date` it serves the paged time series and
 * never assembles the whole record. A malformed `date` is a 400, `code`
 * narrows the snapshot, and series ids read back through `/{id}`.
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
  return {
    ...actual,
    loadFhirContext: vi.fn(),
    loadFhirSeriesScope: vi.fn(),
  };
});
vi.mock("@/lib/fhir/resources", () => ({
  observationsFromReportData: vi.fn(),
}));
vi.mock("@/lib/fhir/series", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fhir/series")>();
  return {
    ...actual,
    querySeriesPage: vi.fn(),
    emitSeriesPage: vi.fn(),
    readSeriesObservation: vi.fn(),
  };
});
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET as observationGet } from "../Observation/route";
import { GET as observationRead } from "../Observation/[id]/route";
import {
  emitSeriesPage,
  querySeriesPage,
  readSeriesObservation,
} from "@/lib/fhir/series";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { loadFhirContext, loadFhirSeriesScope } from "@/lib/fhir/rest";
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
    code: {
      coding: [
        { system: "http://loinc.org", code: id === 1 ? "29463-7" : "x" },
      ],
    },
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
  vi.mocked(loadFhirSeriesScope).mockResolvedValue({
    scope: {
      types: ["WEIGHT"],
      pairBloodPressure: false,
      glucoseContexts: null,
      workouts: true,
    },
    glucoseUnit: "mg/dL",
  });
});

describe("GET /api/fhir/Observation — snapshot stays the default", () => {
  it("serves the snapshot without a date and never touches the series", async () => {
    vi.mocked(observationsFromReportData).mockReturnValue([
      obs(1),
      obs(2),
    ] as never);
    const res = await observationGet(req());
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as { total: number };
    expect(bundle.total).toBe(2);
    expect(loadFhirContext).toHaveBeenCalledTimes(1);
    expect(loadFhirSeriesScope).not.toHaveBeenCalled();
    expect(querySeriesPage).not.toHaveBeenCalled();
  });

  it("narrows the snapshot by code", async () => {
    vi.mocked(observationsFromReportData).mockReturnValue([
      obs(1),
      obs(2),
    ] as never);
    const res = await observationGet(req("?code=http://loinc.org|29463-7"));
    const bundle = (await res.json()) as {
      total: number;
      entry: Array<{ resource: { id: string } }>;
    };
    expect(bundle.total).toBe(1);
    expect(bundle.entry[0].resource.id).toBe("obs-1");
  });
});

describe("GET /api/fhir/Observation?date= — time series", () => {
  it("pages in the database and never assembles the whole record", async () => {
    vi.mocked(querySeriesPage).mockResolvedValue({
      total: 340,
      refs: [{ kind: "m", id: "a" }],
    } as never);
    vi.mocked(emitSeriesPage).mockResolvedValue([
      { ...obs(9), id: "m-a" },
    ] as never);
    const res = await observationGet(
      req("?date=ge2026-01-01&date=lt2026-02-01&_count=50&_offset=100"),
    );
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as {
      total: number;
      link: Array<{ relation: string; url: string }>;
      entry: Array<{ fullUrl: string }>;
    };
    expect(loadFhirContext).not.toHaveBeenCalled();
    expect(querySeriesPage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        count: 50,
        offset: 100,
        range: {
          from: new Date("2026-01-01T00:00:00.000Z"),
          to: new Date("2026-02-01T00:00:00.000Z"),
        },
      }),
    );
    expect(bundle.total).toBe(340);
    expect(bundle.entry[0].fullUrl).toContain("/api/fhir/Observation/m-a");
    const next = bundle.link.find((l) => l.relation === "next");
    expect(next?.url).toContain("_offset=150");
    expect(next?.url).toContain("date=ge2026-01-01");
  });

  it("hands the code filter to the scope", async () => {
    vi.mocked(querySeriesPage).mockResolvedValue({ total: 0, refs: [] });
    vi.mocked(emitSeriesPage).mockResolvedValue([]);
    await observationGet(req("?date=2026&code=80404-7"));
    const codes = vi.mocked(loadFhirSeriesScope).mock.calls[0][1];
    expect([...(codes?.types ?? [])]).toEqual(["HEART_RATE_VARIABILITY"]);
  });

  it("answers a malformed date with a 400 OperationOutcome", async () => {
    const res = await observationGet(req("?date=last-week"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      resourceType: string;
      issue: Array<{ code: string }>;
    };
    expect(body.resourceType).toBe("OperationOutcome");
    expect(body.issue[0].code).toBe("invalid");
    expect(querySeriesPage).not.toHaveBeenCalled();
  });
});

describe("GET /api/fhir/Observation/{id} — series ids", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("reads a series id through the series scope", async () => {
    vi.mocked(readSeriesObservation).mockResolvedValue({
      ...obs(1),
      id: "w-x",
    } as never);
    const res = await observationRead(
      new NextRequest("http://localhost/api/fhir/Observation/w-x"),
      ctx("w-x"),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("w-x");
    expect(loadFhirContext).not.toHaveBeenCalled();
  });

  it("answers an unknown series id with not-found", async () => {
    vi.mocked(readSeriesObservation).mockResolvedValue(null);
    const res = await observationRead(
      new NextRequest("http://localhost/api/fhir/Observation/m-nope"),
      ctx("m-nope"),
    );
    expect(res.status).toBe(404);
  });
});
