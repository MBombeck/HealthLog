import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/doctor-report-data", () => ({
  collectDoctorReportData: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    labResult: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/ai/coach/tools/executor", () => ({
  executeCoachTool: vi.fn(),
}));
vi.mock("@/lib/insights/derived/baseline", () => ({
  loadBaselineProfile: vi.fn(),
}));
vi.mock("@/lib/insights/derived-briefing", () => ({
  detectDerivedBriefingSignals: vi.fn(),
}));
vi.mock("@/lib/insights/illness-cycle-briefing", () => ({
  buildBriefingIllnessCycleContext: vi.fn(),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "UTC"),
}));

import { MCP_PROMPTS, MCP_PROMPT_NAMES } from "../prompts";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { prisma } from "@/lib/db";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { loadBaselineProfile } from "@/lib/insights/derived/baseline";
import { detectDerivedBriefingSignals } from "@/lib/insights/derived-briefing";
import { buildBriefingIllnessCycleContext } from "@/lib/insights/illness-cycle-briefing";
import type { McpAuthContext } from "../auth";

const CTX: McpAuthContext = {
  userId: "user-1",
  tokenId: "token-1",
  scopes: ["health:read"],
  binding: "user-1:token-1",
  canRead: true,
  canWrite: false,
};

function prompt(name: string) {
  const def = MCP_PROMPTS.find((p) => p.name === name);
  if (!def) throw new Error(`prompt ${name} not registered`);
  return def;
}

/** Extract the JSON data block the prompt embeds in its user message. */
function parseData(text: string): Record<string, unknown> {
  const marker = "JSON):\n";
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error("no data block in prompt message");
  return JSON.parse(text.slice(idx + marker.length));
}

/** A minimal but representative doctor-report payload. */
function reportFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
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
    practiceName: null,
    measurements: {},
    stats: {
      WEIGHT: { avg: 80.4, min: 79, max: 82, count: 30, latest: 80 },
      RESTING_HEART_RATE: { avg: 58, min: 52, max: 66, count: 45, latest: 60 },
    },
    glucoseStats: {},
    glucoseRanges: {},
    glucoseUnit: "mgdl",
    glucoseClinical: { stillLearning: true, stillLearningReason: "thin" },
    bmi: 24.1,
    compliance: {
      Ramipril: { total: 90, taken: 86, skipped: 0, missed: 4 },
    },
    medications: [{ name: "Ramipril", dose: "5 mg", schedules: [] }],
    mood: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("MCP prompt registry — surface", () => {
  it("registers the doctor_visit_summary prompt with an args schema", () => {
    expect([...MCP_PROMPT_NAMES]).toContain("doctor_visit_summary");
    const def = prompt("doctor_visit_summary");
    expect(def.title).toBeTruthy();
    expect(def.description).toBeTruthy();
    expect(def.argsShape).toHaveProperty("window");
  });
});

describe("doctor_visit_summary — grounding + structure", () => {
  it("assembles a structured summary from the real doctor-report data", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue(
      reportFixture() as never,
    );

    const res = await prompt("doctor_visit_summary").run(CTX, {
      window: "last90days",
    });

    // One user message carrying framing + data.
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].role).toBe("user");
    const text = res.messages[0].content.text;

    // The window threads through to the data path (trailing 90 days).
    // Third argument: the owner's SAVED selection, replayed. This surface
    // cannot ask a human, so it never invents a scope.
    expect(collectDoctorReportData).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ days: 90 }),
      expect.objectContaining({ version: 2 }),
    );

    const data = parseData(text);
    const vitals = data.vitals as Array<Record<string, unknown>>;
    const weight = vitals.find((v) => v.metric === "WEIGHT")!;
    const rhr = vitals.find((v) => v.metric === "RESTING_HEART_RATE")!;

    // Units + reference bands ride along, server-side.
    expect(weight.unit).toBe("kg");
    expect(weight.referenceBand).toBeNull(); // no universal weight band
    expect(rhr.unit).toBe("bpm");
    expect(rhr.referenceBand).toEqual({ low: 50, high: 100 });

    // Values are the server-computed ones — no fabrication.
    expect(weight.latest).toBe(80);
    expect(rhr.avg).toBe(58);

    // Compliance is the ledger-derived adherence (86/90 → 96 %).
    const compliance = data.compliance as Array<Record<string, unknown>>;
    expect(compliance[0].adherencePct).toBe(96);
  });

  it("injects the grounding framing — no diagnosis, no invented values", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue(
      reportFixture() as never,
    );
    const res = await prompt("doctor_visit_summary").run(CTX, {});
    const text = res.messages[0].content.text;
    expect(text).toMatch(/server-side/i);
    expect(text).toMatch(/do not.*diagnos/i);
    expect(text).toMatch(/do not (invent|estimate|infer)/i);
  });

  it("omits the glucose panel while still learning and mood when absent", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue(
      reportFixture() as never,
    );
    const data = parseData(
      (await prompt("doctor_visit_summary").run(CTX, {})).messages[0].content
        .text,
    );
    expect(data).not.toHaveProperty("glucosePanel"); // stillLearning → withheld
    expect(data).not.toHaveProperty("mood"); // mood null
  });

  it("includes labs with reference ranges and caps the list (token budget)", async () => {
    const labResults = Array.from({ length: 60 }, (_, i) => ({
      panel: null,
      analyte: `Analyte-${i}`,
      value: i,
      valueText: null,
      unit: "mg/dL",
      referenceLow: 0,
      referenceHigh: 100,
      takenAt: "2026-06-01T00:00:00.000Z",
      count: 1,
    }));
    vi.mocked(collectDoctorReportData).mockResolvedValue(
      reportFixture({ labResults }) as never,
    );
    const data = parseData(
      (await prompt("doctor_visit_summary").run(CTX, {})).messages[0].content
        .text,
    );
    const labs = data.labs as Array<Record<string, unknown>>;
    expect(labs.length).toBe(50); // capped from 60
    expect(labs[0]).toHaveProperty("referenceHigh", 100);
  });

  it("does not leak patient name into the summary", async () => {
    vi.mocked(collectDoctorReportData).mockResolvedValue(
      reportFixture() as never,
    );
    const data = parseData(
      (await prompt("doctor_visit_summary").run(CTX, {})).messages[0].content
        .text,
    );
    const patient = data.patient as Record<string, unknown>;
    expect(patient).not.toHaveProperty("fullName");
    expect(patient).not.toHaveProperty("username");
    expect(patient.dateOfBirth).toBe("1990-01-01");
  });
});

// ── Skill-library prompts (weekly_review, medication_check, recovery_check,
// glucose_review, sleep_review, lab_trend_brief) ─────────────────────────────

/** Coach-tool executor returns a present hit echoing the tool name. */
function presentCoachTool() {
  vi.mocked(executeCoachTool).mockImplementation(
    async ({ name }) => ({ present: true, data: { tool: name } }) as never,
  );
}

/** Coach-tool executor returns a grounded absence for every domain. */
function absentCoachTool() {
  vi.mocked(executeCoachTool).mockImplementation(
    async () => ({ present: false, reason: "no_data" }) as never,
  );
}

const NEW_PROMPTS = [
  "weekly_review",
  "medication_check",
  "recovery_check",
  "glucose_review",
  "sleep_review",
  "lab_trend_brief",
] as const;

describe("skill-library prompts — surface", () => {
  it("registers every ranked prompt with a title, description, and args schema", () => {
    for (const name of NEW_PROMPTS) {
      expect([...MCP_PROMPT_NAMES]).toContain(name);
      const def = prompt(name);
      expect(def.title).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(typeof def.argsShape).toBe("object");
    }
  });

  it("does NOT register the deferred prompts (no engine to re-export)", () => {
    expect([...MCP_PROMPT_NAMES]).not.toContain("intervention_review");
    expect([...MCP_PROMPT_NAMES]).not.toContain("preventive_care");
  });
});

describe("weekly_review", () => {
  beforeEach(() => {
    presentCoachTool();
    vi.mocked(loadBaselineProfile).mockResolvedValue({
      ageYears: 35,
      sex: "FEMALE",
      heightCm: 170,
    } as never);
    vi.mocked(detectDerivedBriefingSignals).mockResolvedValue({
      signals: [
        {
          sourceMetric: "recovery",
          label: "recovery",
          score: 58,
          band: "yellow",
          confidence: 72,
        },
      ],
    } as never);
    vi.mocked(buildBriefingIllnessCycleContext).mockResolvedValue({
      illness: { restMode: false, active: [], recentResolved: [] },
      cycle: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      gender: "FEMALE",
    } as never);
  });

  it("assembles trends, adherence, sleep, recovery, drivers, and briefing context", async () => {
    const res = await prompt("weekly_review").run(CTX, {});
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].role).toBe("user");

    const data = parseData(res.messages[0].content.text);
    expect((data.period as { days: number }).days).toBe(7); // default window
    expect(Array.isArray(data.vitals)).toBe(true);
    expect(data).toHaveProperty("medicationAdherence");
    expect(data).toHaveProperty("sleep");
    expect(data).toHaveProperty("recovery");
    expect(data).toHaveProperty("drivers");
    expect(data.derivedSignals).toMatchObject({ present: true });
    expect(data.illnessCycle).toMatchObject({ present: true });

    // userId is taken from context — never a tool argument.
    expect(executeCoachTool).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("surfaces a clean { present: false } for a user with no data", async () => {
    absentCoachTool();
    vi.mocked(detectDerivedBriefingSignals).mockResolvedValue(null);
    vi.mocked(buildBriefingIllnessCycleContext).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);

    const data = parseData(
      (await prompt("weekly_review").run(CTX, {})).messages[0].content.text,
    );
    expect(data.derivedSignals).toMatchObject({ present: false });
    expect(data.illnessCycle).toMatchObject({ present: false });
    const vitals = data.vitals as Array<{ result: { present: boolean } }>;
    expect(vitals.every((v) => v.result.present === false)).toBe(true);
  });

  it("never throws even when the briefing detectors fail", async () => {
    vi.mocked(loadBaselineProfile).mockRejectedValue(new Error("db down"));
    vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error("db down"));
    const res = await prompt("weekly_review").run(CTX, {});
    const data = parseData(res.messages[0].content.text);
    expect(data.derivedSignals).toMatchObject({ present: false });
    expect(data.illnessCycle).toMatchObject({ present: false });
  });

  it("injects the grounding framing — no diagnosis, no invented values", async () => {
    const text = (await prompt("weekly_review").run(CTX, {})).messages[0]
      .content.text;
    expect(text).toMatch(/server-side/i);
    expect(text).toMatch(/do not.*diagnos/i);
    expect(text).toMatch(/do not (invent|estimate|infer)/i);
  });

  it("is read-only — no Prisma write is ever issued", async () => {
    await prompt("weekly_review").run(CTX, {});
    // The only Prisma surface the prompt touches is the read-only findUnique.
    const db = prisma as unknown as Record<string, Record<string, unknown>>;
    expect(db.labResult.findMany).not.toHaveBeenCalled(); // weekly doesn't read labs
    expect(Object.keys(db.user)).toEqual(["findUnique"]);
  });
});

describe("medication_check", () => {
  beforeEach(() => presentCoachTool());

  it("assembles adherence + the linked vital, defaulting the metric to bp", async () => {
    const data = parseData(
      (await prompt("medication_check").run(CTX, {})).messages[0].content.text,
    );
    expect(data).toHaveProperty("adherence");
    const linked = data.linkedMetric as { metric: string };
    expect(linked.metric).toBe("bp");
    expect(executeCoachTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "get_medication_compliance" }),
    );
  });

  it("threads the medication + metric focus args", async () => {
    const data = parseData(
      (
        await prompt("medication_check").run(CTX, {
          medication: "Ramipril",
          metric: "weight",
        })
      ).messages[0].content.text,
    );
    expect(data.medicationFocus).toBe("Ramipril");
    expect((data.linkedMetric as { metric: string }).metric).toBe("weight");
  });

  it("surfaces { present: false } when nothing is tracked", async () => {
    absentCoachTool();
    const data = parseData(
      (await prompt("medication_check").run(CTX, {})).messages[0].content.text,
    );
    expect(data.adherence).toMatchObject({ present: false });
    expect(
      (data.linkedMetric as { result: { present: boolean } }).result,
    ).toMatchObject({ present: false });
  });
});

describe("recovery_check", () => {
  beforeEach(() => presentCoachTool());

  it("assembles recovery composites, baselines, and drivers", async () => {
    const data = parseData(
      (await prompt("recovery_check").run(CTX, {})).messages[0].content.text,
    );
    expect(data).toHaveProperty("recovery");
    expect(Array.isArray(data.baselines)).toBe(true);
    expect(
      (data.baselines as Array<{ metric: string }>).map((b) => b.metric),
    ).toEqual(["resting_hr", "hrv"]);
    expect(data).toHaveProperty("drivers");
  });

  it("surfaces { present: false } cleanly for a bare account", async () => {
    absentCoachTool();
    const data = parseData(
      (await prompt("recovery_check").run(CTX, {})).messages[0].content.text,
    );
    expect(data.recovery).toMatchObject({ present: false });
  });
});

describe("glucose_review", () => {
  it("assembles the glucose panel when present", async () => {
    presentCoachTool();
    const data = parseData(
      (await prompt("glucose_review").run(CTX, {})).messages[0].content.text,
    );
    expect(data.glucose).toMatchObject({ present: true });
    expect(executeCoachTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "get_glucose_panel" }),
    );
  });

  it("surfaces { present: false } when no glucose is logged", async () => {
    absentCoachTool();
    const data = parseData(
      (await prompt("glucose_review").run(CTX, {})).messages[0].content.text,
    );
    expect(data.glucose).toMatchObject({ present: false });
  });
});

describe("sleep_review", () => {
  it("assembles sleep + drivers when present", async () => {
    presentCoachTool();
    const data = parseData(
      (await prompt("sleep_review").run(CTX, {})).messages[0].content.text,
    );
    expect(data.sleep).toMatchObject({ present: true });
    expect(data).toHaveProperty("drivers");
  });

  it("surfaces { present: false } when no sleep is tracked", async () => {
    absentCoachTool();
    const data = parseData(
      (await prompt("sleep_review").run(CTX, {})).messages[0].content.text,
    );
    expect(data.sleep).toMatchObject({ present: false });
  });
});

describe("lab_trend_brief", () => {
  it("refuses with the labs module off and reads no lab row", async () => {
    const { isModuleEnabled } = await import("@/lib/modules/gate");
    vi.mocked(isModuleEnabled).mockImplementation(
      async (_userId, key) => key !== "labs",
    );
    onTestFinished(() => {
      vi.mocked(isModuleEnabled).mockImplementation(async () => true);
    });
    vi.mocked(prisma.labResult.findMany).mockClear();
    await expect(prompt("lab_trend_brief").run(CTX, {})).rejects.toThrow(
      /"labs" module is turned off/,
    );
    expect(prisma.labResult.findMany).not.toHaveBeenCalled();
  });

  it("builds a per-analyte trajectory with stored ranges + status, latest first", async () => {
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([
      {
        analyte: "LDL",
        panel: "Lipids",
        value: 145,
        valueText: null,
        unit: "mg/dL",
        referenceLow: 0,
        referenceHigh: 130,
        takenAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        analyte: "LDL",
        panel: "Lipids",
        value: 120,
        valueText: null,
        unit: "mg/dL",
        referenceLow: 0,
        referenceHigh: 130,
        takenAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ] as never);

    const data = parseData(
      (await prompt("lab_trend_brief").run(CTX, { analyte: "LDL" })).messages[0]
        .content.text,
    );
    expect(data.analyteFilter).toBe("LDL");
    const labs = data.labs as {
      present: boolean;
      analytes: Array<{
        analyte: string;
        readingsOnFile: number;
        history: Array<{ value: number; status: string }>;
      }>;
    };
    expect(labs.present).toBe(true);
    expect(labs.analytes).toHaveLength(1);
    const ldl = labs.analytes[0];
    expect(ldl.analyte).toBe("LDL");
    expect(ldl.readingsOnFile).toBe(2);
    // Newest first; the latest reading sits above the stored reference high.
    expect(ldl.history[0].value).toBe(145);
    expect(ldl.history[0].status).toBe("above");
    expect(ldl.history[1].status).toBe("in_range");
  });

  it("surfaces { present: false } when the analyte has no readings", async () => {
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);
    const data = parseData(
      (await prompt("lab_trend_brief").run(CTX, { analyte: "Ferritin" }))
        .messages[0].content.text,
    );
    expect(data.labs).toMatchObject({
      present: false,
      reason: "analyte_not_found",
    });
  });

  it("surfaces { present: false } when no labs are on file at all", async () => {
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);
    const data = parseData(
      (await prompt("lab_trend_brief").run(CTX, {})).messages[0].content.text,
    );
    expect(data.labs).toMatchObject({ present: false, reason: "no_data" });
  });

  it("never throws when the labs store read fails", async () => {
    vi.mocked(prisma.labResult.findMany).mockRejectedValue(new Error("db"));
    const res = await prompt("lab_trend_brief").run(CTX, {});
    expect(res.messages[0].content.text).toMatch(/present.*false/);
  });

  it("scopes the read to the session user (never a caller-supplied id)", async () => {
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);
    await prompt("lab_trend_brief").run(CTX, {});
    expect(prisma.labResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", deletedAt: null }),
      }),
    );
  });
});
