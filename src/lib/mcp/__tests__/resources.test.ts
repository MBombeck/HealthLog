import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    medication: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/medication-category", () => ({
  resolveMedicationCategories: vi.fn(),
}));
vi.mock("@/lib/doctor-report-data", () => ({
  collectDoctorReportData: vi.fn(),
}));
vi.mock("@/lib/ai/coach/tools/inventory", () => ({
  buildCoachDataInventory: vi.fn(),
}));
// v1.30 (G5/C4) — `measurements-inventory` appends the metric-status-only
// discovery rows; stub the engine so this file never reaches a real DB read.
vi.mock("@/lib/mcp/rich-reads", () => ({
  metricStatusDiscoveryRows: vi.fn(async () => []),
}));

import { MCP_RESOURCES, MCP_RESOURCE_URIS } from "../resources";
import { prisma } from "@/lib/db";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { buildCoachDataInventory } from "@/lib/ai/coach/tools/inventory";
import { metricStatusDiscoveryRows } from "@/lib/mcp/rich-reads";
import { resolveMedicationCategories } from "@/lib/medication-category";
import type { McpAuthContext } from "../auth";

const CTX: McpAuthContext = {
  userId: "user-1",
  tokenId: "token-1",
  scopes: ["health:read"],
  binding: "user-1:token-1",
  canRead: true,
  canWrite: false,
};

function resource(uri: string) {
  const def = MCP_RESOURCES.find((r) => r.uri === uri);
  if (!def) throw new Error(`resource ${uri} not registered`);
  return def;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("MCP resource surface", () => {
  it("registers the fixed resources, none admin", () => {
    expect([...MCP_RESOURCE_URIS].sort()).toEqual([
      "healthlog://labs/catalogue",
      "healthlog://measurements/inventory",
      "healthlog://medications",
      "healthlog://profile",
      "healthlog://report/doctor-visit",
    ]);
    for (const uri of MCP_RESOURCE_URIS) {
      expect(uri).not.toMatch(/admin/i);
    }
  });
});

describe("healthlog://profile", () => {
  it("returns minimised, health-relevant profile data and omits identifiers", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 180,
      dateOfBirth: new Date("1990-01-01T00:00:00Z"),
      gender: "MALE",
      timezone: "Europe/Berlin",
      unitPreference: "metric",
      glucoseUnit: "mmol/L",
    } as never);

    const result = (await resource("healthlog://profile").read(CTX)) as Record<
      string,
      unknown
    >;

    // userId is narrowed from the session, never a caller argument.
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
    expect(result.present).toBe(true);
    expect(result.heightCm).toBe(180);
    expect(typeof result.ageYears).toBe("number");
    expect(result.glucoseUnit).toBe("mmol/L");
    // No direct identifiers leak to the assistant.
    expect(Object.keys(result)).not.toContain("email");
    expect(Object.keys(result)).not.toContain("username");
    expect(Object.keys(result)).not.toContain("role");
  });

  it("returns { present: false } when the user row is missing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const result = (await resource("healthlog://profile").read(CTX)) as {
      present: boolean;
    };
    expect(result.present).toBe(false);
  });
});

describe("healthlog://medications", () => {
  it("lists medications + schedules scoped to the session user", async () => {
    vi.mocked(resolveMedicationCategories).mockResolvedValue({
      "med-a": {
        category: "custom:5f0c6a52-6a43-4f63-9b39-0c1f4d7e2a10",
        categoryLabel: "Travel kit",
      },
    });
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      {
        id: "med-a",
        name: "Med A",
        dose: "10mg",
        treatmentClass: "GENERIC",
        asNeeded: false,
        pausedAt: null,
        startsOn: null,
        endsOn: null,
        schedules: [
          {
            label: "Morning",
            dose: null,
            windowStart: "08:00",
            windowEnd: "10:00",
            timesOfDay: ["08:00"],
            daysOfWeek: null,
            rrule: null,
            rollingIntervalDays: null,
            scheduleType: "SCHEDULED",
          },
        ],
      },
    ] as never);

    const result = (await resource("healthlog://medications").read(
      CTX,
    )) as Record<string, unknown>;

    expect(prisma.medication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(result.present).toBe(true);
    expect(result.count).toBe(1);
    expect(Array.isArray(result.medications)).toBe(true);
    // v1.40 (#1041) — the custom category rides with its label, fenced as
    // the person's own text.
    expect(
      (result.medications as Array<Record<string, unknown>>)[0],
    ).toMatchObject({
      category: "custom:5f0c6a52-6a43-4f63-9b39-0c1f4d7e2a10",
      categoryLabel: "<<<USER_TEXT_START>>>Travel kit<<<USER_TEXT_END>>>",
    });
  });

  it("returns { present: false } when no medications are tracked", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    const result = (await resource("healthlog://medications").read(CTX)) as {
      present: boolean;
      count: number;
    };
    expect(result.present).toBe(false);
    expect(result.count).toBe(0);
  });
});

describe("healthlog://measurements/inventory", () => {
  it("merges the Coach inventory with the metric-status-only discovery rows (G5/C4)", async () => {
    vi.mocked(buildCoachDataInventory).mockResolvedValue({
      entries: [
        {
          tool: "get_metric_series",
          metric: "weight",
          domain: "weight",
          present: true,
          count: 5,
        },
      ],
      restMode: false,
      cycleEnabled: false,
      window: "last30days",
      probeScope: { sources: [] },
    } as never);
    vi.mocked(metricStatusDiscoveryRows).mockResolvedValue([
      {
        tool: "compare_metric",
        domain: "Wrist temperature",
        present: false,
        metric: "WRIST_TEMPERATURE",
      },
    ] as never);

    const result = (await resource("healthlog://measurements/inventory").read(
      CTX,
    )) as { present: boolean; metrics: Array<Record<string, unknown>> };

    expect(metricStatusDiscoveryRows).toHaveBeenCalledWith("user-1");
    expect(result.present).toBe(true);
    expect(result.metrics).toHaveLength(2);
    expect(
      result.metrics.find((m) => m.metric === "WRIST_TEMPERATURE"),
    ).toMatchObject({ present: false });
  });
});

describe("healthlog://report/doctor-visit", () => {
  // The resource now reuses the SHARED summariser (doctor-visit-summary.ts), so
  // it grounds the identical rich superset the doctor_visit_summary prompt does
  // — mood, glucose panel, wellness composites, and illness episodes no longer
  // drop out of the resource.
  it("grounds the rich superset like the prompt when the data is present", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue({
      period: {
        days: 90,
        since: "2026-03-29T00:00:00.000Z",
        start: "2026-03-29T00:00:00.000Z",
        end: "2026-06-27T00:00:00.000Z",
      },
      patient: {
        username: "tester",
        fullName: "A Person",
        dateOfBirth: "1990-01-01",
        gender: "female",
        heightCm: 170,
      },
      stats: { WEIGHT: { avg: 80, min: 79, max: 82, count: 30, latest: 80 } },
      glucoseClinical: { stillLearning: false, timeInRange: 70 },
      bmi: 24,
      compliance: { Ramipril: { total: 90, taken: 86, skipped: 0, missed: 4 } },
      medications: [{ name: "Ramipril", dose: "5 mg", schedules: [] }],
      mood: { avg: 3.5, min: 2, max: 5, count: 12 },
      wellnessScores: [{ type: "RECOVERY", latest: 70, avg: 65 }],
      illnessEpisodes: [
        {
          label: "Cold",
          type: "ILLNESS",
          lifecycle: "resolved",
          onsetAt: "2026-05-01",
          resolvedAt: "2026-05-08",
        },
      ],
    } as never);

    const result = (await resource("healthlog://report/doctor-visit").read(
      CTX,
    )) as Record<string, unknown>;

    // Third argument: the owner's SAVED selection, replayed. This surface
    // cannot ask a human, so it never invents a scope.
    expect(collectDoctorReportData).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ days: 90 }),
      expect.objectContaining({ version: 2 }),
    );
    expect(result.present).toBe(true);
    expect(result).toHaveProperty("vitals");
    expect(result).toHaveProperty("mood");
    expect(result).toHaveProperty("glucosePanel");
    expect(result).toHaveProperty("wellnessScores");
    expect(result).toHaveProperty("illnessEpisodes");
    // Patient name never leaks.
    const patient = result.patient as Record<string, unknown>;
    expect(patient).not.toHaveProperty("fullName");
    expect(patient).not.toHaveProperty("username");
  });

  it("omits absent sections honestly (no zero-fill)", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue({
      period: { days: 90, since: "", start: "", end: "" },
      patient: { dateOfBirth: "1990-01-01", gender: "female", heightCm: 170 },
      // One metric survived the gate, so the record is present; everything
      // else is absent and must stay absent rather than being zero-filled.
      stats: { WEIGHT: { avg: 80, min: 78, max: 82, count: 4, latest: 79 } },
      glucoseClinical: { stillLearning: true },
      bmi: null,
      compliance: {},
      medications: [],
      mood: null,
    } as never);

    const result = (await resource("healthlog://report/doctor-visit").read(
      CTX,
    )) as Record<string, unknown>;
    expect(result.present).toBe(true);
    expect(result).not.toHaveProperty("mood");
    expect(result).not.toHaveProperty("glucosePanel");
    expect(result).not.toHaveProperty("wellnessScores");
    expect(result).not.toHaveProperty("illnessEpisodes");
  });
});
