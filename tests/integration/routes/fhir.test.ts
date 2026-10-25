/**
 * The read-only FHIR R4 face under `/api/fhir`, against the real database and
 * through the real API kit.
 *
 * What a client relies on here:
 *   - the CapabilityStatement describes the instance answering, and every
 *     interaction it advertises has a route behind it;
 *   - each resource route serves the caller's own stored values, as the
 *     owner's saved report selection scopes them, and never another
 *     account's: a foreign id answers a `not-found` OperationOutcome;
 *   - a narrow token passes with the `fhir:read` scope the routes declare and
 *     is refused with any other, and the `fhir:read` token reaches nothing
 *     outside this face;
 *   - `Patient/$everything` carries every family the document export carries,
 *     with references that resolve inside the response, and asks a browser
 *     session for a recent sign-in.
 *
 * The module gate has its own file (`fhir-module-gate.test.ts`).
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { GET as METADATA } from "@/app/api/fhir/metadata/route";
import { GET as PATIENT_SEARCH } from "@/app/api/fhir/Patient/route";
import { GET as PATIENT_READ } from "@/app/api/fhir/Patient/[id]/route";
import { GET as EVERYTHING } from "@/app/api/fhir/Patient/$everything/route";
import { GET as OBSERVATION_SEARCH } from "@/app/api/fhir/Observation/route";
import { GET as OBSERVATION_READ } from "@/app/api/fhir/Observation/[id]/route";
import { GET as STATEMENT_SEARCH } from "@/app/api/fhir/MedicationStatement/route";
import { GET as STATEMENT_READ } from "@/app/api/fhir/MedicationStatement/[id]/route";
import { GET as ADMINISTRATION_SEARCH } from "@/app/api/fhir/MedicationAdministration/route";
import { GET as ADMINISTRATION_READ } from "@/app/api/fhir/MedicationAdministration/[id]/route";
import { GET as COVERAGE_SEARCH } from "@/app/api/fhir/Coverage/route";
import { GET as COVERAGE_READ } from "@/app/api/fhir/Coverage/[id]/route";
import { GET as SESSIONS } from "@/app/api/auth/me/sessions/route";
import { encrypt } from "@/lib/crypto";
import { buildFhirDocumentBundle } from "@/lib/fhir/build-bundle";
import {
  FHIR_READ_SCOPE,
  FHIR_REST_RESOURCE_TYPES,
  loadFhirContext,
} from "@/lib/fhir/rest";
import type { User } from "@/generated/prisma/client";

import {
  anonymous,
  callRoute,
  type CallRouteOptions,
  type RouteAuth,
} from "../../kit/call-route";
import {
  makeMeasurement,
  makeMedication,
  makeSession,
  makeToken,
  makeUser,
} from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const prisma = getPrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;

/** The leaves the seeded owner saved, which is all this face may serve. */
const SAVED_LEAVES = [
  "PATIENT_IDENTITY",
  "INSURANCE",
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "MEDICATION_LIST",
  "MEDICATION_ADMINISTRATIONS",
  "ALLERGIES",
  "FAMILY_HISTORY",
  "ILLNESS_EPISODES",
  "CYCLE",
];

const resourceSchema = z.looseObject({
  resourceType: z.string(),
  id: z.string(),
});
type Resource = z.infer<typeof resourceSchema>;

const bundleSchema = z.object({
  resourceType: z.literal("Bundle"),
  type: z.literal("searchset"),
  total: z.number(),
  link: z.array(z.object({ relation: z.string(), url: z.string() })),
  entry: z.array(
    z.object({
      fullUrl: z.string(),
      search: z.object({ mode: z.string() }),
      resource: resourceSchema,
    }),
  ),
});

const outcomeSchema = z.object({
  resourceType: z.literal("OperationOutcome"),
  issue: z.array(z.object({ severity: z.string(), code: z.string() })),
});

const codedSchema = z.looseObject({
  code: z.object({
    coding: z.array(z.looseObject({ code: z.string() })).optional(),
  }),
});

const referenceSchema = z.looseObject({
  subject: z.object({ reference: z.string() }).optional(),
});

function codesOf(resource: Resource): string[] {
  const parsed = codedSchema.safeParse(resource);
  return parsed.success
    ? (parsed.data.code.coding ?? []).map((c) => c.code)
    : [];
}

interface SeededRecord {
  user: User;
  weightId: string;
}

/**
 * An account with a saved selection and something in every family the
 * selection names, dated inside the default reporting window.
 */
async function seedRecord(values: {
  fullName: string;
  insurerName: string;
  insuranceNumber: string;
  weight: number;
  systolic: number;
  diastolic: number;
  medication: string;
  allergy: string;
}): Promise<SeededRecord> {
  const now = Date.now();
  const user = await makeUser({
    fullName: values.fullName,
    dateOfBirth: new Date("1985-06-15T00:00:00Z"),
    gender: "FEMALE",
    insurerName: values.insurerName,
    insurerIkNumber: "101234567",
    insuranceNumberEncrypted: encrypt(values.insuranceNumber),
    reportSelectionJson: { v: 2, leaves: SAVED_LEAVES },
  });
  const weight = await makeMeasurement(user, {
    type: "WEIGHT",
    value: values.weight,
    unit: "kg",
    measuredAt: new Date(now - 2 * DAY_MS),
  });
  const bpAt = new Date(now - DAY_MS);
  await makeMeasurement(user, {
    type: "BLOOD_PRESSURE_SYS",
    value: values.systolic,
    unit: "mmHg",
    measuredAt: bpAt,
  });
  await makeMeasurement(user, {
    type: "BLOOD_PRESSURE_DIA",
    value: values.diastolic,
    unit: "mmHg",
    measuredAt: bpAt,
  });
  const medication = await makeMedication(user, {
    name: values.medication,
    dose: "5mg",
    createdAt: new Date(now - 30 * DAY_MS),
  });
  const takenAt = new Date(now - DAY_MS);
  await prisma.medicationIntakeEvent.create({
    data: {
      userId: user.id,
      medicationId: medication.id,
      scheduledFor: takenAt,
      takenAt,
    },
  });
  await prisma.allergy.create({
    data: {
      userId: user.id,
      substance: values.allergy,
      category: "MEDICATION",
      severity: "SEVERE",
    },
  });
  await prisma.familyHistoryEntry.create({
    data: {
      userId: user.id,
      relationship: "MOTHER",
      condition: "Hypertension",
      ageAtOnset: 50,
    },
  });
  await prisma.illnessEpisode.create({
    data: {
      userId: user.id,
      label: "Common cold",
      type: "INFECTION",
      onsetAt: new Date(now - 20 * DAY_MS),
      resolvedAt: new Date(now - 10 * DAY_MS),
    },
  });
  for (const [startDate, periodEndDate, lengthDays] of [
    ["2026-07-01", "2026-07-05", 28],
    ["2026-07-29", "2026-08-02", 27],
    ["2026-08-25", "2026-08-29", 29],
  ] as const) {
    await prisma.menstrualCycle.create({
      data: { userId: user.id, startDate, periodEndDate, lengthDays },
    });
  }
  return { user, weightId: weight.id };
}

async function seedOwnerAndStranger() {
  const owner = await seedRecord({
    fullName: "Sample Patient",
    insurerName: "Example Insurer",
    insuranceNumber: "A123456780",
    weight: 79.5,
    systolic: 128,
    diastolic: 82,
    medication: "Example Drug",
    allergy: "Penicillin",
  });
  const stranger = await seedRecord({
    fullName: "Someone Else",
    insurerName: "Other Insurer",
    insuranceNumber: "B987654320",
    weight: 101.1,
    systolic: 151,
    diastolic: 97,
    medication: "Other Drug",
    allergy: "Latex",
  });
  return { owner, stranger };
}

/** The strings that would only appear if the stranger's record leaked. */
const STRANGER_MARKERS = [
  "Someone Else",
  "Other Insurer",
  "B987654320",
  "101.1",
  "Other Drug",
  "Latex",
];

async function fhirCall(
  handler: Parameters<typeof callRoute>[0],
  options: Omit<CallRouteOptions, "method">,
) {
  const res = await callRoute(handler, { method: "GET", ...options });
  if (res.status === 200 || res.status === 404) {
    expect(res.headers.get("content-type")).toContain("application/fhir+json");
  }
  return res;
}

async function search(
  handler: Parameters<typeof callRoute>[0],
  route: string,
  auth: RouteAuth,
  query?: CallRouteOptions["query"],
) {
  const res = await fhirCall(handler, { route, auth, query });
  expect(res.status).toBe(200);
  return { res, bundle: bundleSchema.parse(res.body) };
}

async function read(
  handler: Parameters<typeof callRoute>[0],
  route: string,
  id: string,
  auth: RouteAuth,
) {
  return fhirCall(handler, { route, params: { id }, auth });
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

describe("GET /api/fhir/metadata", () => {
  it("describes the instance answering and advertises only reads and searches that have a route", async () => {
    const owner = await makeUser();
    const res = await fhirCall(METADATA, {
      route: "/api/fhir/metadata",
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(200);
    const statement = z
      .looseObject({
        resourceType: z.literal("CapabilityStatement"),
        description: z.string().min(1),
        software: z.object({ name: z.string(), version: z.string().min(1) }),
        implementation: z.object({
          description: z.string().min(1),
          url: z.string(),
        }),
        rest: z.array(
          z.object({
            resource: z.array(
              z.looseObject({
                type: z.string(),
                interaction: z.array(z.object({ code: z.string() })),
                searchParam: z.array(
                  z.object({ name: z.string(), type: z.string() }),
                ),
                operation: z.array(z.object({ name: z.string() })).optional(),
              }),
            ),
          }),
        ),
      })
      .parse(res.body);

    expect(statement.software.name).toBe("HealthLog");
    expect(statement.implementation.url).toBe("http://localhost:3000/api/fhir");

    const resources = statement.rest[0].resource;
    expect(resources.map((r) => r.type)).toEqual([...FHIR_REST_RESOURCE_TYPES]);
    const patient = resources.filter((r) => r.type === "Patient");
    expect(patient).toHaveLength(1);
    expect(patient[0].operation?.map((o) => o.name)).toEqual(["everything"]);

    // Paging on every search; the Observation search alone honours the
    // time-series range and the code filter, and says so.
    for (const resource of resources) {
      expect(resource.searchParam, resource.type).toEqual([
        { name: "_count", type: "number" },
        { name: "_offset", type: "number" },
        ...(resource.type === "Observation"
          ? [
              { name: "date", type: "date" },
              { name: "code", type: "token" },
            ]
          : []),
      ]);
    }

    const root = path.join(process.cwd(), "src/app/api/fhir");
    for (const resource of resources) {
      for (const { code } of resource.interaction) {
        expect(["read", "search-type"]).toContain(code);
        const file =
          code === "read"
            ? path.join(root, resource.type, "[id]", "route.ts")
            : path.join(root, resource.type, "route.ts");
        expect(existsSync(file), `${resource.type} ${code}`).toBe(true);
      }
      for (const { name } of resource.operation ?? []) {
        const file = path.join(root, resource.type, `$${name}`, "route.ts");
        expect(existsSync(file), `${resource.type} $${name}`).toBe(true);
      }
    }
  });
});

describe("FHIR read scope", () => {
  it("admits a narrow token holding the declared scope", async () => {
    const { owner } = await seedOwnerAndStranger();
    const token = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });

    for (const [handler, route] of [
      [PATIENT_SEARCH, "/api/fhir/Patient"],
      [OBSERVATION_SEARCH, "/api/fhir/Observation"],
      [STATEMENT_SEARCH, "/api/fhir/MedicationStatement"],
      [ADMINISTRATION_SEARCH, "/api/fhir/MedicationAdministration"],
      [COVERAGE_SEARCH, "/api/fhir/Coverage"],
      [EVERYTHING, "/api/fhir/Patient/$everything"],
      [METADATA, "/api/fhir/metadata"],
    ] as const) {
      const res = await fhirCall(handler, { route, auth: token });
      expect(res.status, route).toBe(200);
    }
  });

  it("refuses a narrow token with an unrelated scope, and a caller with none", async () => {
    const { owner } = await seedOwnerAndStranger();
    const ingest = await makeToken(owner.user, {
      permissions: ["measurements:write"],
    });

    for (const [handler, route] of [
      [PATIENT_SEARCH, "/api/fhir/Patient"],
      [OBSERVATION_SEARCH, "/api/fhir/Observation"],
      [EVERYTHING, "/api/fhir/Patient/$everything"],
      [METADATA, "/api/fhir/metadata"],
    ] as const) {
      const refused = await callRoute(handler, {
        method: "GET",
        route,
        auth: ingest,
      });
      expect(refused.status, route).toBe(403);
      expect(refused.meta?.errorCode).toBe("auth.scope.insufficient");
      expect(JSON.stringify(refused.body)).not.toContain("79.5");

      const unauthenticated = await callRoute(handler, {
        method: "GET",
        route,
        auth: anonymous,
      });
      expect(unauthenticated.status, route).toBe(401);
    }
  });

  it("does not let the fhir:read token reach a route outside the FHIR face", async () => {
    const owner = await makeUser();
    const token = await makeToken(owner, { permissions: [FHIR_READ_SCOPE] });

    const res = await callRoute(SESSIONS, {
      method: "GET",
      route: "/api/auth/me/sessions",
      auth: token,
    });

    expect(res.status).toBe(403);
    expect(res.meta?.errorCode).toBe("auth.scope.insufficient");
  });
});

describe("FHIR resources carry the caller's stored values and nobody else's", () => {
  it("serves the owner's Patient with name, birth date, gender and insurance number", async () => {
    const { owner } = await seedOwnerAndStranger();
    const auth = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });

    const { res, bundle } = await search(
      PATIENT_SEARCH,
      "/api/fhir/Patient",
      auth,
    );

    expect(bundle.total).toBe(1);
    expect(bundle.entry[0].resource).toMatchObject({
      resourceType: "Patient",
      id: "patient-1",
      name: [{ text: "Sample Patient" }],
      birthDate: "1985-06-15",
      gender: "female",
      identifier: [expect.objectContaining({ value: "A123456780" })],
    });
    for (const marker of STRANGER_MARKERS) {
      expect(JSON.stringify(res.body)).not.toContain(marker);
    }

    const single = await read(
      PATIENT_READ,
      "/api/fhir/Patient/{id}",
      "patient-1",
      auth,
    );
    expect(single.status).toBe(200);
    expect(single.body).toEqual(bundle.entry[0].resource);
  });

  it("serves the owner's latest weight and blood-pressure panel, and each search entry reads back by id", async () => {
    const { owner } = await seedOwnerAndStranger();
    const auth = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });

    const { res, bundle } = await search(
      OBSERVATION_SEARCH,
      "/api/fhir/Observation",
      auth,
    );

    const resources = bundle.entry.map((e) => e.resource);
    const weight = resources.find((r) => codesOf(r).includes("29463-7"));
    expect(weight).toMatchObject({
      status: "final",
      valueQuantity: expect.objectContaining({ value: 79.5, unit: "kg" }),
    });
    const panel = resources.find((r) => codesOf(r).includes("85354-9"));
    expect(panel).toMatchObject({
      component: expect.arrayContaining([
        expect.objectContaining({
          code: expect.objectContaining({
            coding: [expect.objectContaining({ code: "8480-6" })],
          }),
          valueQuantity: expect.objectContaining({ value: 128 }),
        }),
        expect.objectContaining({
          code: expect.objectContaining({
            coding: [expect.objectContaining({ code: "8462-4" })],
          }),
          valueQuantity: expect.objectContaining({ value: 82 }),
        }),
      ]),
    });
    for (const marker of STRANGER_MARKERS) {
      expect(JSON.stringify(res.body)).not.toContain(marker);
    }

    for (const entry of bundle.entry) {
      expect(entry.fullUrl).toBe(
        `http://localhost:3000/api/fhir/Observation/${entry.resource.id}`,
      );
      const single = await read(
        OBSERVATION_READ,
        "/api/fhir/Observation/{id}",
        entry.resource.id,
        auth,
      );
      expect(single.status).toBe(200);
      expect(single.body).toEqual(entry.resource);
    }

    const missing = await read(
      OBSERVATION_READ,
      "/api/fhir/Observation/{id}",
      "obs-999",
      auth,
    );
    expect(missing.status).toBe(404);
    expect(outcomeSchema.parse(missing.body).issue[0].code).toBe("not-found");
  });

  it("reads a stored measurement by its series id, and answers not-found for another account's", async () => {
    const { owner, stranger } = await seedOwnerAndStranger();
    const auth = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });

    const own = await read(
      OBSERVATION_READ,
      "/api/fhir/Observation/{id}",
      `m-${owner.weightId}`,
      auth,
    );
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({
      resourceType: "Observation",
      id: `m-${owner.weightId}`,
      valueQuantity: expect.objectContaining({ value: 79.5 }),
    });

    const foreign = await read(
      OBSERVATION_READ,
      "/api/fhir/Observation/{id}",
      `m-${stranger.weightId}`,
      auth,
    );
    expect(foreign.status).toBe(404);
    expect(outcomeSchema.parse(foreign.body).issue[0].code).toBe("not-found");
    expect(JSON.stringify(foreign.body)).not.toContain("101.1");
  });

  it("lists the stored series in a date range, newest first, and only the owner's rows", async () => {
    const { owner } = await seedOwnerAndStranger();
    const auth = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });
    const since = new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10);

    const { res, bundle } = await search(
      OBSERVATION_SEARCH,
      "/api/fhir/Observation",
      auth,
      { date: `ge${since}` },
    );

    // The weight and the paired blood-pressure reading.
    expect(bundle.total).toBe(2);
    expect(bundle.entry.map((e) => e.resource.id)[1]).toBe(
      `m-${owner.weightId}`,
    );
    for (const marker of STRANGER_MARKERS) {
      expect(JSON.stringify(res.body)).not.toContain(marker);
    }
  });

  it("serves the owner's medication statement and taken dose", async () => {
    const { owner } = await seedOwnerAndStranger();
    const auth = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });

    const statements = await search(
      STATEMENT_SEARCH,
      "/api/fhir/MedicationStatement",
      auth,
    );
    expect(statements.bundle.total).toBe(1);
    expect(statements.bundle.entry[0].resource).toMatchObject({
      resourceType: "MedicationStatement",
      id: "med-1",
      status: "active",
      medicationCodeableConcept: { text: "Example Drug" },
      dosage: [{ text: "5mg" }],
    });

    const administrations = await search(
      ADMINISTRATION_SEARCH,
      "/api/fhir/MedicationAdministration",
      auth,
    );
    expect(administrations.bundle.total).toBe(1);
    expect(administrations.bundle.entry[0].resource).toMatchObject({
      resourceType: "MedicationAdministration",
      id: "medadmin-1",
      status: "completed",
      medicationCodeableConcept: { text: "Example Drug" },
    });

    for (const res of [statements.res, administrations.res]) {
      for (const marker of STRANGER_MARKERS) {
        expect(JSON.stringify(res.body)).not.toContain(marker);
      }
    }

    const statement = await read(
      STATEMENT_READ,
      "/api/fhir/MedicationStatement/{id}",
      "med-1",
      auth,
    );
    expect(statement.body).toEqual(statements.bundle.entry[0].resource);
    const administration = await read(
      ADMINISTRATION_READ,
      "/api/fhir/MedicationAdministration/{id}",
      "medadmin-1",
      auth,
    );
    expect(administration.body).toEqual(
      administrations.bundle.entry[0].resource,
    );
    const missing = await read(
      STATEMENT_READ,
      "/api/fhir/MedicationStatement/{id}",
      "med-2",
      auth,
    );
    expect(missing.status).toBe(404);
  });

  it("serves the owner's Coverage with the insurer and member number", async () => {
    const { owner } = await seedOwnerAndStranger();
    const auth = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });

    const { res, bundle } = await search(
      COVERAGE_SEARCH,
      "/api/fhir/Coverage",
      auth,
    );
    expect(bundle.total).toBe(1);
    expect(bundle.entry[0].resource).toMatchObject({
      resourceType: "Coverage",
      id: "coverage-1",
      subscriberId: "A123456780",
      contained: [
        expect.objectContaining({
          name: "Example Insurer",
          identifier: [expect.objectContaining({ value: "101234567" })],
        }),
      ],
    });
    for (const marker of STRANGER_MARKERS) {
      expect(JSON.stringify(res.body)).not.toContain(marker);
    }

    const single = await read(
      COVERAGE_READ,
      "/api/fhir/Coverage/{id}",
      "coverage-1",
      auth,
    );
    expect(single.body).toEqual(bundle.entry[0].resource);
  });

  it("serves nothing from a record whose owner never saved a selection", async () => {
    const owner = await makeUser({
      fullName: "Unscoped Owner",
      insurerName: "Example Insurer",
      insuranceNumberEncrypted: encrypt("A123456780"),
    });
    await makeMeasurement(owner, {
      value: 66.6,
      measuredAt: new Date(Date.now() - DAY_MS),
    });
    await makeMedication(owner, { name: "Unscoped Drug" });
    const auth = await makeToken(owner, { permissions: [FHIR_READ_SCOPE] });

    const observations = await search(
      OBSERVATION_SEARCH,
      "/api/fhir/Observation",
      auth,
    );
    expect(observations.bundle.total).toBe(0);
    const statements = await search(
      STATEMENT_SEARCH,
      "/api/fhir/MedicationStatement",
      auth,
    );
    expect(statements.bundle.total).toBe(0);
    const coverage = await search(COVERAGE_SEARCH, "/api/fhir/Coverage", auth);
    expect(coverage.bundle.total).toBe(0);
    const patient = await search(PATIENT_SEARCH, "/api/fhir/Patient", auth);
    expect(patient.bundle.entry[0].resource).toEqual({
      resourceType: "Patient",
      id: "patient-1",
    });
    for (const res of [
      observations.res,
      statements.res,
      coverage.res,
      patient.res,
    ]) {
      const body = JSON.stringify(res.body);
      for (const marker of ["66.6", "Unscoped", "A123456780"]) {
        expect(body).not.toContain(marker);
      }
    }
  });
});

describe("FHIR paging", () => {
  it("pages a search with _count and _offset and links the next page", async () => {
    const { owner } = await seedOwnerAndStranger();
    const auth = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });

    const all = await search(OBSERVATION_SEARCH, "/api/fhir/Observation", auth);
    expect(all.bundle.total).toBeGreaterThan(1);

    const first = await search(
      OBSERVATION_SEARCH,
      "/api/fhir/Observation",
      auth,
      { _count: 1 },
    );
    expect(first.bundle.total).toBe(all.bundle.total);
    expect(first.bundle.entry.map((e) => e.resource.id)).toEqual([
      all.bundle.entry[0].resource.id,
    ]);
    const next = first.bundle.link.find((l) => l.relation === "next");
    expect(next?.url).toContain("_offset=1");

    const second = await search(
      OBSERVATION_SEARCH,
      "/api/fhir/Observation",
      auth,
      { _count: 1, _offset: 1 },
    );
    expect(second.bundle.entry.map((e) => e.resource.id)).toEqual([
      all.bundle.entry[1].resource.id,
    ]);
  });

  it("answers an offset past the ceiling with an invalid OperationOutcome", async () => {
    const { owner } = await seedOwnerAndStranger();
    const auth = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });

    const res = await callRoute(OBSERVATION_SEARCH, {
      method: "GET",
      route: "/api/fhir/Observation",
      query: { _offset: "1e20" },
      auth,
    });

    expect(res.status).toBe(400);
    expect(outcomeSchema.parse(res.body).issue[0].code).toBe("invalid");
  });

  it("throttles a caller past the hourly FHIR budget with a throttled OperationOutcome", async () => {
    const { owner } = await seedOwnerAndStranger();
    const auth = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });
    await prisma.rateLimit.create({
      data: {
        key: `fhir:${owner.user.id}`,
        count: 120,
        resetAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const res = await callRoute(PATIENT_SEARCH, {
      method: "GET",
      route: "/api/fhir/Patient",
      auth,
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/fhir+json");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(outcomeSchema.parse(res.body).issue[0].code).toBe("throttled");
    expect(JSON.stringify(res.body)).not.toContain("Sample Patient");
  });
});

describe("GET /api/fhir/Patient/$everything", () => {
  it("returns every family the document export carries, with references that resolve inside the response", async () => {
    const { owner } = await seedOwnerAndStranger();
    const auth = await makeToken(owner.user, {
      permissions: [FHIR_READ_SCOPE],
    });

    const { res, bundle } = await search(
      EVERYTHING,
      "/api/fhir/Patient/$everything",
      auth,
      { _count: 200 },
    );

    const context = await loadFhirContext(owner.user.id);
    const document = buildFhirDocumentBundle(
      context.data,
      context.identity,
      undefined,
      { germanAtc: context.germanAtc },
      context.records,
    );
    expect(bundle.total).toBe(document.entry.length);
    expect(
      bundle.entry.map((e) => `${e.resource.resourceType}/${e.resource.id}`),
    ).toEqual(
      document.entry.map((e) => `${e.resource.resourceType}/${e.resource.id}`),
    );

    const served = new Set(bundle.entry.map((e) => e.resource.resourceType));
    for (const type of [
      "Composition",
      "Device",
      "Patient",
      "Coverage",
      "Observation",
      "MedicationStatement",
      "MedicationAdministration",
      "Condition",
      "Encounter",
      "AllergyIntolerance",
      "FamilyMemberHistory",
      "DiagnosticReport",
    ]) {
      expect(served.has(type), `missing ${type}`).toBe(true);
    }
    // The cycle Observations share a resourceType with the vitals and would
    // hide inside the set check above.
    expect(
      bundle.entry.some((e) => e.resource.id.startsWith("obs-cycle-")),
    ).toBe(true);
    const body = JSON.stringify(res.body);
    for (const stored of ["Penicillin", "Hypertension", "Example Drug"]) {
      expect(body).toContain(stored);
    }
    for (const marker of STRANGER_MARKERS) {
      expect(body).not.toContain(marker);
    }

    const urls = new Set(bundle.entry.map((e) => e.fullUrl));
    for (const entry of bundle.entry) {
      expect(entry.fullUrl.startsWith("urn:uuid:")).toBe(true);
      expect(entry.search.mode).toBe("match");
      const subject = referenceSchema.parse(entry.resource).subject?.reference;
      if (subject) expect(urls.has(subject)).toBe(true);
    }
  });

  it("serves a browser session that signed in a moment ago", async () => {
    const { owner } = await seedOwnerAndStranger();

    const res = await fhirCall(EVERYTHING, {
      route: "/api/fhir/Patient/$everything",
      auth: await makeSession(owner.user),
    });

    expect(res.status).toBe(200);
    expect(bundleSchema.parse(res.body).total).toBeGreaterThan(0);
  });

  it("asks a browser session that signed in an hour ago to confirm first", async () => {
    const { owner } = await seedOwnerAndStranger();
    const session = await makeSession(owner.user);
    await prisma.session.update({
      where: { id: session.sessionId },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const res = await callRoute(EVERYTHING, {
      method: "GET",
      route: "/api/fhir/Patient/$everything",
      auth: session,
    });

    expect(res.status).toBe(401);
    expect(res.meta?.errorCode).toBe("auth.reproof.required");
    expect(JSON.stringify(res.body)).not.toContain("Sample Patient");
  });
});
