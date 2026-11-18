import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findMany: vi.fn(), findFirst: vi.fn() },
    labResult: { findMany: vi.fn() },
    biomarker: { findMany: vi.fn(async () => []) },
    // v1.30 — the nutrients pipeline.
    nutrientIntakeDay: {
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/labs/biomarker-resolve", () => ({
  resolveMarkerForRead: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/coach/tools/executor", () => ({
  executeCoachTool: vi.fn(),
}));
vi.mock("@/lib/mcp/data-inventory", () => ({
  buildMcpDataInventory: vi.fn(),
}));
vi.mock("@/lib/doctor-report-data", () => ({
  collectDoctorReportData: vi.fn(),
}));
// v1.30 — the nutrients module is opt-in; default this suite's tenant to
// having it enabled unless a test overrides it.
vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
}));

import {
  MCP_RESOURCE_TEMPLATES,
  MCP_RESOURCE_TEMPLATE_URIS,
  MCP_RESOURCES,
  MCP_WINDOW_VALUES,
} from "../resources";
import { prisma } from "@/lib/db";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { buildMcpDataInventory } from "@/lib/mcp/data-inventory";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { isModuleEnabled } from "@/lib/modules/gate";
import type { McpAuthContext } from "../auth";

const CTX: McpAuthContext = {
  userId: "user-1",
  tokenId: "token-1",
  scopes: ["health:read"],
  binding: "user-1:token-1",
  canRead: true,
  canWrite: false,
};

function template(name: string) {
  const def = MCP_RESOURCE_TEMPLATES.find((t) => t.name === name);
  if (!def) throw new Error(`template ${name} not registered`);
  return def;
}

function fixed(uri: string) {
  const def = MCP_RESOURCES.find((r) => r.uri === uri);
  if (!def) throw new Error(`resource ${uri} not registered`);
  return def;
}

const INVENTORY = {
  window: "last90days",
  restMode: false,
  cycleEnabled: false,
  entries: [
    {
      tool: "get_metric_series",
      domain: "weight",
      present: true,
      metric: "weight",
    },
    {
      tool: "get_metric_series",
      domain: "blood pressure",
      present: true,
      metric: "bp",
    },
    {
      tool: "get_metric_series",
      domain: "steps",
      present: false,
      metric: "steps",
    },
  ],
  probeScope: {} as never,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("MCP resource-template surface", () => {
  it("registers the browseable template + fixed-resource set", () => {
    expect([...MCP_RESOURCE_TEMPLATE_URIS].sort()).toEqual([
      "healthlog://lab/{analyte}",
      "healthlog://medication/{id}",
      "healthlog://metric/{type}",
      "healthlog://metric/{type}/{window}",
      "healthlog://nutrient/{code}",
      "healthlog://report/doctor-visit/{window}",
    ]);
    const fixedUris = MCP_RESOURCES.map((r) => r.uri).sort();
    expect(fixedUris).toEqual([
      "healthlog://labs/catalogue",
      "healthlog://measurements/inventory",
      "healthlog://medications",
      "healthlog://profile",
      "healthlog://report/doctor-visit",
    ]);
    for (const uri of [...MCP_RESOURCE_TEMPLATE_URIS, ...fixedUris]) {
      expect(uri).not.toMatch(/admin/i);
    }
  });
});

describe("healthlog://metric/{type}", () => {
  it("resolves a metric via the get_metric_series read, scoped to the session user", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({
      present: true,
      data: { metric: "weight" },
    } as never);

    const result = (await template("metric").read(CTX, {
      type: "weight",
    })) as Record<string, unknown>;

    expect(executeCoachTool).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        name: "get_metric_series",
        rawArguments: JSON.stringify({ metric: "weight" }),
      }),
    );
    expect(result.present).toBe(true);
  });

  it("passes the window through on the windowed template", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({ present: false } as never);
    await template("metric-windowed").read(CTX, {
      type: "bp",
      window: "last30days",
    });
    expect(executeCoachTool).toHaveBeenCalledWith(
      expect.objectContaining({
        rawArguments: JSON.stringify({ metric: "bp", window: "last30days" }),
      }),
    );
  });
});

describe("healthlog://lab/{analyte}", () => {
  it("resolves a lab analyte via the get_labs read, scoped to the session user", async () => {
    vi.mocked(executeCoachTool).mockResolvedValue({
      present: true,
      data: { analyte: "LDL" },
    } as never);

    const result = (await template("lab").read(CTX, {
      analyte: "LDL",
    })) as Record<string, unknown>;

    expect(executeCoachTool).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        name: "get_labs",
        rawArguments: JSON.stringify({ analyte: "LDL" }),
      }),
    );
    expect(result.present).toBe(true);
  });
});

describe("healthlog://medication/{id}", () => {
  it("returns the medication scoped to the session user", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValue({
      name: "Med A",
      dose: "10mg",
      treatmentClass: "GENERIC",
      asNeeded: false,
      pausedAt: null,
      startsOn: null,
      endsOn: null,
      schedules: [],
    } as never);

    const result = (await template("medication").read(CTX, {
      id: "med-1",
    })) as Record<string, unknown>;

    // The where clause narrows by BOTH id and the session userId — a foreign
    // id can never resolve to another tenant's row.
    expect(prisma.medication.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "med-1", userId: "user-1" },
      }),
    );
    expect(result.present).toBe(true);
    expect(result.name).toBe("Med A");
  });

  it("returns { present: false } for an id that is not this user's", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    const result = (await template("medication").read(CTX, {
      id: "someone-elses",
    })) as { present: boolean };
    expect(result.present).toBe(false);
  });
});

describe("healthlog://report/doctor-visit", () => {
  it("reuses the doctor-report data path scoped to the session user", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue({
      period: { days: 90, since: "x", start: "s", end: "e" },
      patient: { dateOfBirth: null, gender: "MALE", heightCm: 180 },
      bmi: 24,
      stats: { WEIGHT: { latest: 80, avg: 81, min: 79, max: 83, count: 12 } },
      compliance: {},
      medications: [],
      labResults: [],
    } as never);

    const result = (await fixed("healthlog://report/doctor-visit").read(
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
    expect(Array.isArray(result.vitals)).toBe(true);
  });

  it("maps the window to its day-count on the windowed template", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue({
      period: { days: 30, since: "x", start: "s", end: "e" },
      patient: { dateOfBirth: null, gender: null, heightCm: null },
      bmi: null,
      stats: {},
      compliance: {},
      medications: [],
      labResults: [],
    } as never);

    await template("doctor-visit-windowed").read(CTX, { window: "last30days" });
    // Third argument: the owner's SAVED selection, replayed. This surface
    // cannot ask a human, so it never invents a scope.
    expect(collectDoctorReportData).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ days: 30 }),
      expect.objectContaining({ version: 2 }),
    );
  });
});

describe("healthlog://labs/catalogue (fixed)", () => {
  it("returns the static biomarker catalogue without any user read", async () => {
    const result = (await fixed("healthlog://labs/catalogue").read(
      CTX,
    )) as Record<string, unknown>;
    expect(result.present).toBe(true);
    expect(Array.isArray(result.biomarkers)).toBe(true);
    expect((result.biomarkers as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("argument completion (user-scoped, doubles as discovery)", () => {
  it("completes metric types from ONLY the user's present inventory", async () => {
    vi.mocked(buildMcpDataInventory).mockResolvedValue(INVENTORY as never);
    const complete = template("metric").complete!.type;
    const all = await complete(CTX, "");
    // `steps` is present:false in the inventory → never suggested.
    expect(all.sort()).toEqual(["bp", "weight"]);
    const filtered = await complete(CTX, "wei");
    expect(filtered).toEqual(["weight"]);
    expect(buildMcpDataInventory).toHaveBeenCalledWith("user-1", {
      availability: false,
    });
  });

  it("completes analytes from ONLY the user's own lab set", async () => {
    // One name per marker: the markers with readings, then the names of
    // readings filed under no marker (v1.43).
    vi.mocked(prisma.biomarker.findMany).mockResolvedValue([
      { name: "LDL" },
    ] as never);
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([
      { analyte: "HDL" },
      { analyte: "ldl" },
    ] as never);
    const complete = template("lab").complete!.analyte;
    const result = await complete(CTX, "ld");
    expect(prisma.biomarker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", results: { some: { deletedAt: null } } },
      }),
    );
    expect(prisma.labResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", deletedAt: null, biomarkerId: null },
        distinct: ["analyte"],
      }),
    );
    expect(result).toEqual(["LDL"]);
    // An empty value returns the user's whole own set (honest discovery).
    expect((await complete(CTX, "")).sort()).toEqual(["HDL", "LDL"]);
  });

  it("completes the fixed window enum by prefix", async () => {
    const complete = template("metric-windowed").complete!.window;
    expect(await complete(CTX, "last9")).toEqual(["last90days"]);
    expect((await complete(CTX, "")).sort()).toEqual(
      [...MCP_WINDOW_VALUES].sort(),
    );
  });
});

describe("healthlog://nutrient/{code} (v1.30 coverage review G1)", () => {
  it("resolves a nutrient via the get_nutrients read, scoped to the session user", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: "UTC",
      gender: null,
    } as never);
    vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([
      { day: "2026-07-10", amount: 1800 },
    ] as never);

    const result = (await template("nutrient").read(CTX, {
      code: "water",
    })) as Record<string, unknown>;

    expect(result.present).toBe(true);
    expect(result.nutrient).toBe("water");
  });

  it("returns { present: false } when the opt-in nutrients module is off", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValueOnce(false);
    const result = (await template("nutrient").read(CTX, {
      code: "water",
    })) as { present: boolean };
    expect(result.present).toBe(false);
  });

  it("completes + lists ONLY the user's own logged nutrient codes", async () => {
    vi.mocked(prisma.nutrientIntakeDay.groupBy).mockResolvedValue([
      { nutrient: "water" },
      { nutrient: "vitamin_d" },
    ] as never);

    const list = await template("nutrient").list!(CTX);
    expect(list.map((r) => r.uri).sort()).toEqual([
      "healthlog://nutrient/vitamin_d",
      "healthlog://nutrient/water",
    ]);

    const complete = template("nutrient").complete!.code;
    expect(await complete(CTX, "vit")).toEqual(["vitamin_d"]);
  });

  it("lists nothing when the opt-in module is off (no leaked code list)", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValueOnce(false);
    vi.mocked(prisma.nutrientIntakeDay.groupBy).mockResolvedValue([
      { nutrient: "water" },
    ] as never);
    const list = await template("nutrient").list!(CTX);
    expect(list).toEqual([]);
  });
});

describe("template listing (browseable, user-scoped)", () => {
  it("lists only the user's present metrics", async () => {
    vi.mocked(buildMcpDataInventory).mockResolvedValue(INVENTORY as never);
    const list = await template("metric").list!(CTX);
    expect(list.map((r) => r.uri).sort()).toEqual([
      "healthlog://metric/bp",
      "healthlog://metric/weight",
    ]);
  });

  it("lists only the user's own medications", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-1", name: "Med A", dose: "10mg" },
    ] as never);
    const list = await template("medication").list!(CTX);
    expect(prisma.medication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(list[0].uri).toBe("healthlog://medication/med-1");
  });
});
