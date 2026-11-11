/**
 * v1.30.22 — the `doctorReport` gate on the whole-record aggregate.
 *
 * `collectDoctorReportData` consulted `resolveModuleMap` for its per-domain
 * SECTIONS (mood / sleep / glucose / cycle / labs / recovery / workouts) but
 * never for the `doctorReport` key that decides whether the aggregate may be
 * assembled at all. Unlike `loadFhirContext` it carried no internal backstop,
 * so it was left entirely to callers to remember — and the MCP surface did
 * not: the fixed resource, its `{window}` template, and the
 * `doctor_visit_summary` prompt each assembled the full record for an account
 * with the module off.
 *
 * REFUSE, not omit. This is the whole record, so there is no honest partial
 * answer; `/api/export/health-record` already answers 403 for exactly this
 * state, and an empty summary invites the assistant to narrate "nothing on
 * file" — a worse failure than an explicit unavailability.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/doctor-report-data", () => ({
  collectDoctorReportData: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => null) },
    medication: { findMany: vi.fn(async () => []) },
    labResult: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/ai/coach/tools/inventory", () => ({
  buildCoachDataInventory: vi.fn(async () => ({})),
}));
vi.mock("@/lib/ai/coach/tools/executor", () => ({
  executeCoachTool: vi.fn(async () => ({ present: false })),
}));
vi.mock("@/lib/insights/derived/baseline", () => ({
  loadBaselineProfile: vi.fn(async () => ({})),
}));
vi.mock("@/lib/insights/derived-briefing", () => ({
  detectDerivedBriefingSignals: vi.fn(async () => null),
}));
vi.mock("@/lib/insights/illness-cycle-briefing", () => ({
  buildBriefingIllnessCycleContext: vi.fn(async () => null),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "Europe/Berlin"),
}));
vi.mock("@/lib/mcp/rich-reads", () => ({
  metricStatusDiscoveryRows: vi.fn(async () => []),
  MCP_METRIC_STATUS_DISCOVERY: [],
  MCP_CLINICAL_SIGNALS: [],
  getNutrients: vi.fn(async () => ({ present: false })),
  getLabHistory: vi.fn(async () => ({ present: false })),
  resolveRichMetric: vi.fn(() => null),
}));

import { MCP_RESOURCES, MCP_RESOURCE_TEMPLATES } from "../resources";
import { MCP_PROMPTS } from "../prompts";
import { isModuleEnabled } from "@/lib/modules/gate";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import type { McpAuthContext } from "../auth";

const ctx = { userId: "u1" } as McpAuthContext;

/** Minimal aggregate the visit summariser can reduce without throwing. */
const REPORT_FIXTURE = {
  period: {
    days: 90,
    since: "2026-03-29T00:00:00.000Z",
    start: "2026-03-29T00:00:00.000Z",
    end: "2026-06-27T00:00:00.000Z",
  },
  patient: { name: "tester" },
  stats: { WEIGHT: { avg: 80, min: 79, max: 82, count: 30, latest: 80 } },
  compliance: {},
  medications: [],
  labs: [],
};

const fixedResource = MCP_RESOURCES.find(
  (r) => r.uri === "healthlog://report/doctor-visit",
)!;
const templateResource = MCP_RESOURCE_TEMPLATES.find(
  (t) => t.uriTemplate === "healthlog://report/doctor-visit/{window}",
)!;
const prompt = MCP_PROMPTS.find((p) => p.name === "doctor_visit_summary")!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isModuleEnabled).mockImplementation(async () => true);
  vi.mocked(collectDoctorReportData).mockResolvedValue(
    REPORT_FIXTURE as unknown as Awaited<
      ReturnType<typeof collectDoctorReportData>
    >,
  );
});

describe("doctor-visit aggregate — doctorReport module gate", () => {
  describe.each([
    {
      name: "fixed resource",
      run: () => fixedResource.read(ctx),
    },
    {
      name: "windowed template",
      run: () => templateResource.read(ctx, { window: "last30days" }),
    },
    {
      name: "doctor_visit_summary prompt",
      run: () => prompt.run(ctx, {}),
    },
  ])("$name", ({ run }) => {
    it("serves with the module ON", async () => {
      await expect(run()).resolves.toBeDefined();
      expect(collectDoctorReportData).toHaveBeenCalled();
    });

    it("REFUSES with the module OFF and never assembles the record", async () => {
      vi.mocked(isModuleEnabled).mockImplementation(async () => false);

      await expect(run()).rejects.toThrow(/doctorReport/);
      // The refusal must precede assembly — the whole point is that the
      // record is never built, not that it is built and then withheld.
      expect(collectDoctorReportData).not.toHaveBeenCalled();
    });

    it("refuses on the operator kill-switch path too", async () => {
      // `isModuleEnabled` ANDs operator availability over the user toggle, so
      // an operator disabling `doctorReport` server-wide arrives as the same
      // `false`. The sharper case: no per-account setting can override it.
      vi.mocked(isModuleEnabled).mockImplementation(
        async (_u: string, key: string) => key !== "doctorReport",
      );

      await expect(run()).rejects.toThrow(/doctorReport/);
      expect(collectDoctorReportData).not.toHaveBeenCalled();
    });
  });

  it("gates on doctorReport specifically", async () => {
    await fixedResource.read(ctx);
    expect(isModuleEnabled).toHaveBeenCalledWith("u1", "doctorReport");
  });
});
