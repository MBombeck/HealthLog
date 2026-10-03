/**
 * POST /api/export/health-record unit coverage.
 *
 * Mock-based (no testcontainers): pins the route contract — strict Zod
 * rejection paths (422 via returnAllZodIssues), rate-limit (429), the three
 * format outputs (PDF magic bytes, application/fhir+json valid Bundle,
 * application/zip), and that the user is narrowed from the session, never the
 * body.
 *
 * The second half is the artefact-level proof that the selection means the
 * same thing in every format: each case runs the real route end to end and
 * reads what comes out, with a positive control beside each exclusion so
 * nothing can pass on an empty fixture.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PDFParse } from "pdf-parse";
import { unzipSync } from "fflate";

vi.mock("@/lib/db", () => ({
  prisma: {
    // `groupBy` sizes the report's dense windows (#1023): a sparse account.
    measurement: {
      findMany: vi.fn(),
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
    },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    labResult: { findMany: vi.fn() },
    illnessEpisode: { findMany: vi.fn() },
    encounter: { findMany: vi.fn() },
    allergy: { findMany: vi.fn() },
    vaccinationRecord: { findMany: vi.fn() },
    familyHistoryEntry: { findMany: vi.fn() },
    userHealthProfile: { findUnique: vi.fn() },
    healthProfileFactRevision: { findMany: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    // The whole-record gate reads the session's own stamps: a sign-in a
    // moment ago is the proof, on an account without a second factor.
    session: {
      findUnique: vi.fn(async () => ({
        createdAt: new Date(),
        mfaVerifiedAt: null,
        reproofAt: null,
      })),
    },
    webauthnMfaCredential: { count: vi.fn(async () => 0) },
    passkey: { count: vi.fn(async () => 0) },
  },
  toJson: (value: unknown) => value,
}));
// The cycle summary has its own aggregation behind it; this suite is about the
// route, so it is stubbed to a fixed shape. Whether it is CALLED at all is the
// property that matters here, and the aggregator sweep asserts that directly.
vi.mock("@/lib/cycle/export-data", () => ({
  buildCycleExportSummary: vi.fn(async () => ({
    lastPeriodStart: "2026-02-01",
    recentCycles: [
      { startDate: "2026-02-01", lengthDays: 28, periodLengthDays: 5 },
    ],
    observedCycleCount: 1,
    averageCycleLengthDays: 28,
    cycleLengthVariabilityDays: null,
    averagePeriodLengthDays: 5,
    currentPhase: "FOLLICULAR",
  })),
}));
vi.mock("@/lib/crypto", () => ({ decrypt: vi.fn(() => "A123456789") }));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: vi.fn((payload: Uint8Array) =>
    Buffer.from(payload).toString("utf8"),
  ),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/geo", () => ({ lookupIpLocation: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitStructuredLog: vi.fn() }));
// Partial: the aggregator's canonical-source collapse calls `userDayKey` from
// the same module, so a total mock breaks any fixture that carries rows.
vi.mock("@/lib/tz/resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tz/resolver")>();
  return {
    ...actual,
    resolveUserTimezone: vi.fn().mockResolvedValue("Europe/Berlin"),
  };
});

// v1.18.0 — the health-record aggregator resolves the per-user module map
// so a disabled data-domain module never reaches the export. Stub the gate
// to "all modules enabled" (an empty map ⇒ default-on) so these pre-existing
// route tests don't stand up the real gate's DB reads.
vi.mock("@/lib/modules/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/gate")>();
  return {
    ...actual,
    resolveModuleMap: vi.fn(),
    isModuleEnabled: vi.fn(),
    requireModuleEnabled: vi.fn(),
  };
});

import { prisma } from "@/lib/db";
import { ALL_LEAF_IDS } from "@/lib/report-selection/catalogue";
import { decrypt } from "@/lib/crypto";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  resolveModuleMap,
  isModuleEnabled,
  requireModuleEnabled,
} from "@/lib/modules/gate";

const SESSION_OK = {
  session: {
    id: "session-1",
    expiresAt: new Date(Date.now() + 3_600_000),
    actingAsUserId: null,
  },
  user: { id: "user-1", email: "test@example.com", role: "USER" },
} as const;

/** A selection body carrying exactly these leaves. */
function sel(...leaves: string[]) {
  return { v: 2, leaves };
}

/** Everything the catalogue knows — the positive-control scope. */
function allLeaves() {
  return { v: 2, leaves: [...ALL_LEAF_IDS] };
}

function mkReq(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/export/health-record", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function pdfText(res: Response): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const parser = new PDFParse({ data: bytes });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

async function pdfBytesText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveModuleMap).mockResolvedValue({} as never);
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
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
  vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.encounter.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.allergy.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.vaccinationRecord.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.familyHistoryEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.userHealthProfile.findUnique).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.healthProfileFactRevision.findMany).mockResolvedValue(
    [] as never,
  );
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
    const res = await POST(mkReq({ format: "xml", selection: sel() }));
    expect(res.status).toBe(422);
  });

  it("rejects a missing format with 422", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ selection: sel() }));
    expect(res.status).toBe(422);
  });

  it("rejects a selection that admits nothing with 422", async () => {
    // The panel disables its own submit in that state, so only a hand-built
    // request gets here. Rendering an empty report and spending a rate-limit
    // slot on it would be the wrong answer; this route has no documents-only
    // mode that would make an empty leaf list a legitimate scope.
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "pdf", selection: sel() }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("export.selection.empty");
  });

  it("rejects a userId smuggled into the body with 422", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({ format: "pdf", selection: sel(), userId: "user-2" }),
    );
    expect(res.status).toBe(422);
  });

  it("returns 403 when the doctorReport module is disabled (B3 gate)", async () => {
    const { apiError } = await import("@/lib/api-response");
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "doctorReport" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "doctorReport",
      }),
    } as never);
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir", selection: sel() }));
    expect(res.status).toBe(403);
    expect(requireModuleEnabled).toHaveBeenCalledWith("user-1", "doctorReport");
  });

  it("returns 429 when the export rate limit is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 3_600_000,
    } as never);
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir", selection: sel() }));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/export/health-record — outputs", () => {
  it("format=fhir returns a valid FHIR document Bundle", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir", selection: allLeaves() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/fhir+json");
    const bundle = await res.json();
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("document");
    expect(bundle.entry[0].resource.resourceType).toBe("Composition");
  });

  it("format=pdf returns a PDF with the %PDF- magic bytes", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "pdf", selection: allLeaves() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("format=package returns a zip", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({ format: "package", selection: allLeaves() }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    // ZIP local-file-header magic: PK\x03\x04
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("renders the PDF in the explicit selection locale", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({
        format: "pdf",
        locale: "de",
        selection: allLeaves(),
        practiceName: "Sample Practice",
      }),
    );
    const text = await pdfText(res);
    // German cover label.
    expect(text).toContain("Praxis:");
  });

  it("falls back to the healthlog-locale cookie when no locale is sent", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq(
        {
          format: "pdf",
          selection: allLeaves(),
          practiceName: "Sample Practice",
        },
        {
          // Browser default English, but the in-app cookie says German — the
          // cookie must win over Accept-Language.
          "accept-language": "en-US,en;q=0.9",
          cookie: "healthlog-locale=de",
        },
      ),
    );
    const text = await pdfText(res);
    expect(text).toContain("Praxis:");
    expect(text).not.toContain("Practice:");
  });

  it("uses Accept-Language only when neither selection nor cookie is present", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq(
        {
          format: "pdf",
          selection: allLeaves(),
          practiceName: "Sample Practice",
        },
        { "accept-language": "en-US,en;q=0.9" },
      ),
    );
    const text = await pdfText(res);
    expect(text).toContain("Practice:");
  });

  it("scopes the aggregator measurement read to the session user", async () => {
    const { POST } = await import("../route");
    await POST(
      mkReq({ format: "fhir", selection: sel(), userId: "user-2" } as never),
    );
    // userId smuggle is rejected above; here we confirm the read uses the
    // session user, not anything from the body, for a clean payload.
    await POST(mkReq({ format: "fhir", selection: allLeaves() }));
    expect(prisma.measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", deletedAt: null }),
      }),
    );
  });
});

/**
 * The selection has to mean the same thing in every artefact.
 *
 * Three defects met here. The export panel rendered eight measurement switches
 * that the grouped-to-flat fold discarded, so deselecting body fat or VO₂max
 * exported them anyway. The medication switch documented itself as excluding
 * all medication data while the drug list and the per-dose ledger went out
 * unconditionally. And the route fetched allergies and family history without
 * consulting the toggles at all, so `sections.allergies = false` produced a PDF
 * without an allergy section and a FHIR bundle carrying every one of them — in
 * the `package` format, inside the same zip.
 *
 * Each case below runs the real route end to end and reads the produced
 * artefact. Mutation check: revert any single gate and its case goes red while
 * the positive control beside it stays green, so none of them can pass by
 * asserting on an empty fixture.
 */
describe("POST /api/export/health-record — the selection reaches every format", () => {
  const T0 = new Date("2026-02-01T08:00:00.000Z");

  function measurement(type: string, value: number) {
    return {
      type,
      value,
      measuredAt: T0,
      source: "MANUAL",
      deviceType: null,
      sleepStage: null,
      glucoseContext: null,
    };
  }

  function allergyRow() {
    return {
      id: "allergy-1",
      substance: "Penicillin",
      category: "MEDICATION",
      type: "ALLERGY",
      severity: "SEVERE",
      status: "ACTIVE",
      onsetAt: null,
      reactionEncrypted: null,
      notesEncrypted: null,
      createdAt: T0,
      updatedAt: T0,
    };
  }

  function familyHistoryRow() {
    return {
      id: "fmh-1",
      relationship: "MOTHER",
      condition: "Hypertension",
      ageAtOnset: 52,
      notesEncrypted: null,
      createdAt: T0,
      updatedAt: T0,
    };
  }

  function medicationRow() {
    return {
      id: "med-1",
      name: "Sample medication",
      dose: "5 mg",
      atcCode: null,
      rxNormCode: null,
      deliveryForm: null,
      active: true,
      schedules: [],
      scheduleRevisions: [],
      pauseEras: [],
      courses: [],
      doseChanges: [],
      intakeEvents: [],
    };
  }

  /** Resource types present in the bundle a given selection produces. */
  async function bundleResourceTypes(selection: {
    v: number;
    leaves: string[];
  }): Promise<string[]> {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir", selection }));
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as {
      entry: { resource: { resourceType: string; code?: unknown } }[];
    };
    return bundle.entry.map((e) => e.resource.resourceType);
  }

  /** The LOINC/HealthKit codes of every Observation a selection produces. */
  async function observationCodes(selection: {
    v: number;
    leaves: string[];
  }): Promise<string[]> {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir", selection }));
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as {
      entry: {
        resource: {
          resourceType: string;
          code?: { coding?: { code: string }[]; text?: string };
        };
      }[];
    };
    return bundle.entry
      .filter((e) => e.resource.resourceType === "Observation")
      .flatMap((e) => [
        ...(e.resource.code?.coding?.map((c) => c.code) ?? []),
        e.resource.code?.text ?? "",
      ]);
  }

  it("honours every previously-dead measurement switch in the FHIR bundle", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      measurement("BODY_FAT", 21),
      measurement("OXYGEN_SATURATION", 97),
      measurement("BONE_MASS", 3.1),
      measurement("RESTING_HEART_RATE", 54),
      measurement("HEART_RATE_VARIABILITY", 61),
      measurement("VO2_MAX", 44),
      measurement("ACTIVITY_STEPS", 8400),
      measurement("WALKING_RUNNING_DISTANCE", 6200),
    ] as never);

    // Positive control: with all eight leaves chosen, all eight are emitted.
    // Without this the exclusion assertion below could pass on an empty bundle.
    const on = await observationCodes(
      sel(
        "BODY_FAT",
        "OXYGEN_SATURATION",
        "BONE_MASS",
        "RESTING_HEART_RATE",
        "HEART_RATE_VARIABILITY",
        "VO2_MAX",
        "ACTIVITY_STEPS",
        "WALKING_RUNNING_DISTANCE",
      ),
    );
    expect(on.length).toBeGreaterThanOrEqual(8);

    // A selection naming something else entirely carries none of them —
    // absence of a leaf is exclusion, not a default.
    const off = await observationCodes(sel("PULSE"));
    expect(off).toEqual([]);
  });

  it("keeps the deselected measurement rows out of the query in the first place", async () => {
    await bundleResourceTypes(sel("PULSE"));
    const lastCall = vi.mocked(prisma.measurement.findMany).mock.calls.at(-1)!;
    const where = lastCall[0]!.where as { type?: { notIn?: string[] } };
    expect(where.type?.notIn).toContain("BODY_FAT");
    expect(where.type?.notIn).toContain("VO2_MAX");
    expect(where.type?.notIn).not.toContain("PULSE");
  });

  it("omits the deselected vitals from the PDF table", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      measurement("BODY_FAT", 21),
      measurement("OXYGEN_SATURATION", 97),
    ] as never);
    const { POST } = await import("../route");

    const withBoth = await pdfText(
      await POST(
        mkReq({
          format: "pdf",
          locale: "en",
          selection: sel("BODY_FAT", "OXYGEN_SATURATION"),
        }),
      ),
    );
    expect(withBoth).toContain("Body Fat");

    const without = await pdfText(
      await POST(
        mkReq({
          format: "pdf",
          locale: "en",
          selection: sel("PULSE"),
        }),
      ),
    );
    expect(without).not.toContain("Body Fat");
  });

  it("holds the mental-health screening totals back unless they are asked for by name", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      measurement("PHQ9_SCORE", 11),
      measurement("GAD7_SCORE", 8),
    ] as never);

    // The module is on (the default since v1.29.1) and the caller names other
    // leaves: the totals must stay in the database.
    expect(await observationCodes(sel("LAB_RESULTS"))).toEqual([]);
    // And an empty selection — the "I said nothing" case, which used to mean
    // "give me everything" and is now refused outright, so the totals cannot
    // ride out on a scope nobody chose.
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir", selection: sel() }));
    expect(res.status).toBe(422);

    // Asked for by name, they are emitted — the data is withheld, not lost.
    const asked = await observationCodes(sel("PHQ9_SCORE", "GAD7_SCORE"));
    expect(asked).toContain("44261-6");
    expect(asked).toContain("70274-6");
  });

  it("lets the medication switch withhold the medication list", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medicationRow(),
    ] as never);

    expect(await bundleResourceTypes(sel("MEDICATION_LIST"))).toContain(
      "MedicationStatement",
    );
    expect(
      await bundleResourceTypes(sel("MEDICATION_COMPLIANCE")),
    ).not.toContain("MedicationStatement");
  });

  it("keeps allergies and family history out of the FHIR bundle when deselected", async () => {
    vi.mocked(prisma.allergy.findMany).mockResolvedValue([
      allergyRow(),
    ] as never);
    vi.mocked(prisma.familyHistoryEntry.findMany).mockResolvedValue([
      familyHistoryRow(),
    ] as never);

    const on = await bundleResourceTypes(sel("ALLERGIES", "FAMILY_HISTORY"));
    expect(on).toContain("AllergyIntolerance");
    expect(on).toContain("FamilyMemberHistory");

    const off = await bundleResourceTypes(sel("PULSE"));
    expect(off).not.toContain("AllergyIntolerance");
    expect(off).not.toContain("FamilyMemberHistory");
  });

  it("never reads the deselected records from the database", async () => {
    await bundleResourceTypes(sel("PULSE"));
    expect(prisma.allergy.findMany).not.toHaveBeenCalled();
    expect(prisma.familyHistoryEntry.findMany).not.toHaveBeenCalled();
  });

  it("ships a package whose bundle agrees with its PDF", async () => {
    vi.mocked(prisma.allergy.findMany).mockResolvedValue([
      allergyRow(),
    ] as never);
    vi.mocked(prisma.familyHistoryEntry.findMany).mockResolvedValue([
      familyHistoryRow(),
    ] as never);

    const { POST } = await import("../route");
    const res = await POST(
      mkReq({ format: "package", selection: sel("PULSE") }),
    );
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const bundle = JSON.parse(
      new TextDecoder().decode(files["bundle.json"]!),
    ) as { entry: { resource: { resourceType: string } }[] };
    const types = bundle.entry.map((e) => e.resource.resourceType);
    // The compliant PDF and the violating bundle used to travel together.
    expect(types).not.toContain("AllergyIntolerance");
    expect(types).not.toContain("FamilyMemberHistory");
  });
  it("ships selected anamnesis in both package artefacts and omits it otherwise", async () => {
    const encrypted = (value: string) => new TextEncoder().encode(value);
    vi.mocked(prisma.userHealthProfile.findUnique).mockResolvedValue({
      conditionsEncrypted: encrypted("Asthma"),
    } as never);
    vi.mocked(prisma.healthProfileFactRevision.findMany).mockResolvedValue([
      {
        kind: "SMOKING_STATUS",
        valueEncrypted: encrypted("FORMER"),
      },
      {
        kind: "ALCOHOL_PATTERN",
        valueEncrypted: encrypted("OCCASIONAL"),
      },
      {
        kind: "SHIFT_SCHEDULE",
        valueEncrypted: encrypted("ROTATING"),
      },
    ] as never);

    const { POST } = await import("../route");
    const selected = await POST(
      mkReq({
        format: "package",
        locale: "en",
        selection: sel("ANAMNESIS"),
      }),
    );
    expect(selected.status).toBe(200);
    const selectedFiles = unzipSync(
      new Uint8Array(await selected.arrayBuffer()),
    );
    const selectedPdf = await pdfBytesText(selectedFiles["report.pdf"]!);
    expect(selectedPdf).toContain("Asthma");
    expect(selectedPdf).toContain("Former smoker");
    expect(selectedPdf).toContain("Occasional");
    expect(selectedPdf).toContain("Rotating shifts");

    const selectedBundle = JSON.parse(
      new TextDecoder().decode(selectedFiles["bundle.json"]!),
    ) as {
      entry: {
        resource: {
          resourceType: string;
          code?: { coding?: { code?: string }[] };
          valueCodeableConcept?: { text?: string };
        };
      }[];
    };
    const selectedFacts = selectedBundle.entry
      .map((entry) => entry.resource)
      .filter(
        (resource) =>
          resource.resourceType === "Observation" &&
          ["72166-2", "11331-6", "74159-5"].includes(
            resource.code?.coding?.[0]?.code ?? "",
          ),
      );
    expect(
      selectedFacts.map((fact) => fact.valueCodeableConcept?.text),
    ).toEqual(["Former smoker", "Occasional", "Rotating shifts"]);

    vi.mocked(prisma.userHealthProfile.findUnique).mockClear();
    vi.mocked(prisma.healthProfileFactRevision.findMany).mockClear();
    const omitted = await POST(
      mkReq({
        format: "package",
        locale: "en",
        selection: sel("PULSE"),
      }),
    );
    expect(omitted.status).toBe(200);
    const omittedFiles = unzipSync(new Uint8Array(await omitted.arrayBuffer()));
    const omittedPdf = await pdfBytesText(omittedFiles["report.pdf"]!);
    expect(omittedPdf).not.toContain("Asthma");
    const omittedBundle = JSON.parse(
      new TextDecoder().decode(omittedFiles["bundle.json"]!),
    ) as typeof selectedBundle;
    expect(
      omittedBundle.entry.some((entry) =>
        ["72166-2", "11331-6", "74159-5"].includes(
          entry.resource.code?.coding?.[0]?.code ?? "",
        ),
      ),
    ).toBe(false);
    expect(prisma.userHealthProfile.findUnique).not.toHaveBeenCalled();
    expect(prisma.healthProfileFactRevision.findMany).not.toHaveBeenCalled();
  });
});

/**
 * What the route remembers: the practice name and the scope the owner chose,
 * so the panel opens carrying both next time and the surfaces that cannot ask
 * a human have a real act to replay.
 *
 * The write happens only once the artefact exists — a generation that throws
 * must not overwrite the remembered values with a half-typed name or a scope
 * that produced nothing.
 *
 * Mutation checks: drop the `rememberChoices` call and the first cases go red;
 * move it above the generation and the failed-generation case goes red; drop
 * `reportSelectionJson` from the update and "remembers the chosen scope" goes
 * red.
 */
describe("POST /api/export/health-record — what the route remembers", () => {
  it("persists the sanitised practice name after a PDF export", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({
        format: "pdf",
        selection: sel("WEIGHT"),
        practiceName: "  Sample   Practice  ",
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({
        lastReportPracticeName: "Sample Practice",
      }),
    });
  });

  it("remembers the chosen scope, in catalogue order", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({
        format: "fhir",
        selection: sel("LAB_RESULTS", "WEIGHT"),
        range: { days: 180 },
        includeCharts: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({
        reportSelectionJson: {
          v: 2,
          leaves: ["WEIGHT", "LAB_RESULTS"],
          format: "fhir",
          rangeDays: 180,
          includeCharts: false,
        },
      }),
    });
  });

  it("refuses a leaf id this build does not know, and remembers nothing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({ format: "pdf", selection: sel("SOMETHING_NEW") }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("SOMETHING_NEW");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("persists the practice name after a FHIR export", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({
        format: "fhir",
        selection: sel("WEIGHT"),
        practiceName: "Sample Practice",
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({
        lastReportPracticeName: "Sample Practice",
      }),
    });
  });

  it("persists null when the user cleared the practice name", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "pdf", selection: sel("WEIGHT") }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: expect.objectContaining({ lastReportPracticeName: null }),
    });
  });

  it("writes nothing when the selection is rejected", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({
        format: "xml",
        selection: sel("WEIGHT"),
        practiceName: "Sample",
      }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("writes nothing when the generation fails", async () => {
    vi.mocked(prisma.measurement.findMany).mockRejectedValue(
      new Error("read failed"),
    );
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({
        format: "pdf",
        selection: sel("WEIGHT"),
        practiceName: "Sample Practice",
      }),
    );
    expect(res.status).toBe(500);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("narrows the update to the session user, never the body", async () => {
    const { POST } = await import("../route");
    await POST(
      mkReq({
        format: "fhir",
        selection: sel("WEIGHT"),
        practiceName: "Sample Practice",
      }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
  });
});

/**
 * The insurance number is its own leaf, and it is the most sensitive value on
 * this path: encrypted at rest, and the one identifier a share link may never
 * carry at all.
 *
 * Mutation check: drop the `selection.has("INSURANCE")` condition on the
 * decrypt and "never decrypts the insurance number" goes red.
 */
describe("POST /api/export/health-record — the insurance leaf", () => {
  beforeEach(() => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      username: "sample",
      dateOfBirth: null,
      gender: null,
      heightCm: null,
      glucoseUnit: null,
      thresholdsJson: null,
      fullName: null,
      insurerName: "Sample Insurer",
      insurerIkNumber: "123456789",
      insuranceNumberEncrypted: Buffer.from("ciphertext"),
    } as never);
  });

  it("never decrypts the insurance number when the leaf was not chosen", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({ format: "fhir", selection: sel("WEIGHT", "PATIENT_IDENTITY") }),
    );
    expect(res.status).toBe(200);
    // Not decrypted, so it never entered this process's memory — the stronger
    // statement than "it was decrypted and then left out".
    expect(decrypt).not.toHaveBeenCalled();
    const bundle = (await res.json()) as {
      entry: { resource: { resourceType: string } }[];
    };
    expect(bundle.entry.map((e) => e.resource.resourceType)).not.toContain(
      "Coverage",
    );
  });

  it("decrypts and carries it when the leaf was chosen by name", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({
        format: "fhir",
        selection: sel("WEIGHT", "PATIENT_IDENTITY", "INSURANCE"),
      }),
    );
    expect(res.status).toBe(200);
    expect(decrypt).toHaveBeenCalled();
    const text = JSON.stringify(await res.json());
    expect(text).toContain("A123456789");
  });
});

describe("POST /api/export/health-record — a fresh proof on the browser", () => {
  it("a session that signed in an hour ago is asked to confirm first", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      mfaVerifiedAt: null,
      reproofAt: null,
    } as never);
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "pdf", selection: allLeaves() }));
    expect(res.status).toBe(401);
    expect((await res.json()).meta.errorCode).toBe("auth.reproof.required");
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });
});
