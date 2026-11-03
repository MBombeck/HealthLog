/**
 * GET /api/meta/capabilities route tests.
 *
 * This endpoint exists to retire the "doc says N, server ships M" enum-drift
 * class for the native client — so the drift-guard assertions ARE the point:
 *
 *   1. 401 when unauthenticated.
 *   2. `derivedMetricIds` is exactly the derived registry's id set (same
 *      length AND members) — the endpoint can never silently diverge from
 *      the registry it claims to mirror.
 *   3. `ingest.writeAllowlist` deep-equals the `WRITABLE_MEASUREMENT_SOURCES`
 *      constant — a client reads the live write allowlist, not a copy.
 *   4. Every quantity-mapping row + the FHIR constants + the contract version
 *      are sourced from the canonical server constants, not hand-typed here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The route transitively imports `@/lib/insights/derived/wellness-scores`,
// which imports the Prisma client; mock it so the module graph loads without
// a real DB. The route itself only reads `WELLNESS_SCORE_TYPES` (a plain
// object), never the client.
vi.mock("@/lib/db", () => ({ prisma: {} }));

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

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { DERIVED_METRIC_IDS } from "@/lib/insights/derived/registry";
import { WRITABLE_MEASUREMENT_SOURCES } from "@/lib/validations/measurement";
import { APPLE_HEALTH_TYPE_MAP } from "@/lib/measurements/apple-health-mapping";
import {
  ATC_SYSTEM,
  SNOMED_SYSTEM,
  GERMAN_ATC_DEFAULT_LOCALES,
} from "@/lib/fhir/build-bundle";
import {
  FHIR_REST_RESOURCE_TYPES,
  FHIR_EVERYTHING_OPERATION,
  FHIR_SEARCH_PARAMS,
} from "@/lib/fhir/rest";
import { SHARE_LINK_MAX_DAYS } from "@/lib/validations/clinician-share-link";
import {
  ALL_LEAF_IDS,
  REPORT_GROUP_ORDER,
  SENSITIVE_GROUP_ID,
} from "@/lib/report-selection/catalogue";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

type CapabilitiesBody = {
  data: {
    apiContractVersion: string;
    derivedMetricIds: string[];
    vitalsBaselineTypes: string[];
    layoutTileIds: string[];
    metricStatusIds: string[];
    ingest: {
      quantityTypes: { type: string; hk: string; unit: string }[];
      eventTypes: string[];
      computedScores: string[];
      writeAllowlist: string[];
    };
    fhir: {
      atcSystem: string;
      snomedRoute: string;
      germanAtcDefaultLocales: string[];
      restBaseUrl: string;
      scopeMintable: boolean;
      resourceTypes: string[];
      operations: string[];
      searchParams: string[];
    };
    share: {
      supported: boolean;
      maxDays: number;
      reportDownload: string[];
      selectionVersion: number;
      groups: { id: string; leaves: string[]; sensitive?: boolean }[];
      leaves: string[];
    };
  };
};

async function call(): Promise<Response> {
  return (GET as unknown as () => Promise<Response>)();
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/meta/capabilities — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
  });
});

describe("GET /api/meta/capabilities — drift guards", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  });

  it("derivedMetricIds is exactly the derived registry's id set", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as CapabilitiesBody;

    // Length AND membership — the endpoint cannot silently drift from the
    // registry (the whole reason it exists).
    expect(body.data.derivedMetricIds.length).toBe(DERIVED_METRIC_IDS.length);
    expect([...body.data.derivedMetricIds].sort()).toEqual(
      [...DERIVED_METRIC_IDS].sort(),
    );
  });

  it("ingest.writeAllowlist deep-equals WRITABLE_MEASUREMENT_SOURCES", async () => {
    const res = await call();
    const body = (await res.json()) as CapabilitiesBody;
    expect(body.data.ingest.writeAllowlist).toEqual([
      ...WRITABLE_MEASUREMENT_SOURCES,
    ]);
  });

  it("computedScores are the three persisted wellness scores", async () => {
    const res = await call();
    const body = (await res.json()) as CapabilitiesBody;
    expect([...body.data.ingest.computedScores].sort()).toEqual([
      "RECOVERY_SCORE",
      "STRAIN_SCORE",
      "STRESS_SCORE",
    ]);
  });

  it("fhir constants mirror the FHIR builder source", async () => {
    const res = await call();
    const body = (await res.json()) as CapabilitiesBody;
    expect(body.data.fhir.atcSystem).toBe(ATC_SYSTEM);
    expect(body.data.fhir.snomedRoute).toBe(SNOMED_SYSTEM);
    expect(body.data.fhir.germanAtcDefaultLocales).toEqual([
      ...GERMAN_ATC_DEFAULT_LOCALES,
    ]);
  });

  it("fhir REST descriptor mirrors the canonical rest.ts constants", async () => {
    const res = await call();
    const body = (await res.json()) as CapabilitiesBody;
    expect(body.data.fhir.restBaseUrl).toBe("/api/fhir");
    // The face checks `fhir:read`, but nothing mints a token carrying it, so
    // advertising it as an obtainable credential would be a claim the code
    // cannot support.
    expect(body.data.fhir.scopeMintable).toBe(false);
    expect(body.data.fhir.resourceTypes).toEqual([...FHIR_REST_RESOURCE_TYPES]);
    expect(body.data.fhir.operations).toEqual([FHIR_EVERYTHING_OPERATION]);
    expect(body.data.fhir.searchParams).toEqual([...FHIR_SEARCH_PARAMS]);
  });

  it("share descriptor mirrors the canonical share-link + section sources", async () => {
    const res = await call();
    const body = (await res.json()) as CapabilitiesBody;
    expect(body.data.share.supported).toBe(true);
    expect(body.data.share.maxDays).toBe(SHARE_LINK_MAX_DAYS);
    // The record IS reachable in machine form now — as a download under the
    // token, not as a bearer API. The old `fhirApi: false` described a face
    // that was never built.
    expect(body.data.share.reportDownload).toEqual(["fhir", "pdf"]);
    expect(body.data.share.selectionVersion).toBe(2);
    expect(body.data.share.groups.map((g) => g.id)).toEqual([
      ...REPORT_GROUP_ORDER,
    ]);
    expect([...body.data.share.leaves].sort()).toEqual(
      [...ALL_LEAF_IDS].sort(),
    );
  });

  it("share.groups carries membership: every leaf in exactly one group, fence flagged once", async () => {
    const res = await call();
    const body = (await res.json()) as CapabilitiesBody;

    const seen = new Set<string>();
    for (const group of body.data.share.groups) {
      for (const leaf of group.leaves) {
        expect(seen.has(leaf), `${leaf} appears in more than one group`).toBe(
          false,
        );
        seen.add(leaf);
      }
    }
    // Every leaf in the flat set is in exactly one group, and no group holds
    // a leaf absent from the flat set — the invariant that makes a native
    // client's fence trustworthy.
    expect([...seen].sort()).toEqual([...body.data.share.leaves].sort());

    const sensitiveGroups = body.data.share.groups.filter((g) => g.sensitive);
    expect(sensitiveGroups).toHaveLength(1);
    expect(sensitiveGroups[0]?.id).toBe(SENSITIVE_GROUP_ID);
  });

  it("quantityTypes are sourced from the HealthKit ingest mapping", async () => {
    const res = await call();
    const body = (await res.json()) as CapabilitiesBody;

    // Every emitted quantity row must trace back to a real mapping entry —
    // never an entry the ingest path doesn't actually accept.
    const byHk = new Map(
      Object.values(APPLE_HEALTH_TYPE_MAP).map((m) => [m.hkIdentifier, m]),
    );
    expect(body.data.ingest.quantityTypes.length).toBeGreaterThan(0);
    for (const q of body.data.ingest.quantityTypes) {
      const mapping = byHk.get(q.hk);
      expect(mapping).toBeDefined();
      expect(q.type).toBe(mapping!.measurementType);
      expect(q.unit).toBe(mapping!.dbUnit);
      // Quantity rows are the non-event-class mappings.
      expect(
        Boolean(
          mapping!.eventClassificationMap || mapping!.fallbackClassification,
        ),
      ).toBe(false);
    }
  });

  it("apiContractVersion is a non-empty string", async () => {
    const res = await call();
    const body = (await res.json()) as CapabilitiesBody;
    expect(typeof body.data.apiContractVersion).toBe("string");
    expect(body.data.apiContractVersion.length).toBeGreaterThan(0);
  });
});
