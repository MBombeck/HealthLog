/**
 * Every MCP read of medications, labs, conditions and (v1.42) the
 * environment honours the module switch (v1.39.3 review).
 *
 * `search` and `fetch` gained the rule with the clinical-record kinds; the
 * rest of the surface has to say the same thing, or the claim that a
 * switched-off module is invisible to a connected assistant is only true of
 * two tools. Each read below answers `{ present: false, reason:
 * "module_disabled" }` (or lists nothing) without touching the table.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const disabled = new Set<string>();

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async (_u: string, key: string) => !disabled.has(key)),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/ai/coach/tools/executor", () => ({
  executeCoachTool: vi.fn(async () => ({ present: true, data: {} })),
}));
vi.mock("@/lib/ai/coach/tools/inventory", () => ({
  buildCoachDataInventory: vi.fn(),
}));
vi.mock("@/lib/mcp/rich-reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/rich-reads")>()),
  getLabHistory: vi.fn(async () => ({ present: true, readings: [] })),
}));
vi.mock("@/lib/links", () => ({
  listTargets: vi.fn(async () => []),
  listTargetsBySource: vi.fn(
    async () =>
      new Map([["v-1", [{ id: "c-1", label: "Knee pain", date: null }]]]),
  ),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: (b: Uint8Array) => Buffer.from(b).toString("utf8"),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
    medication: {
      findMany: vi.fn(async () => [
        { id: "m-1", name: "Ramipril", dose: "5mg", schedules: [] },
      ]),
      findFirst: vi.fn(async () => ({
        id: "m-1",
        name: "Ramipril",
        dose: "5mg",
        schedules: [],
      })),
    },
    labResult: { findMany: vi.fn(async () => [{ analyte: "LDL" }]) },
    encounter: {
      findMany: vi.fn(async () => [
        {
          id: "v-1",
          occurredAt: new Date("2025-01-01T00:00:00Z"),
          status: "DONE",
          kind: "ROUTINE",
          reasonEncrypted: null,
          outcomeEncrypted: null,
          bodySiteEncrypted: null,
          laterality: null,
          practitioner: {
            name: "Dr. Gone",
            specialty: "Cardiology",
            deletedAt: new Date(),
          },
        },
      ]),
    },
  },
}));

import { MCP_TOOLS } from "../tools";
import { MCP_RESOURCES, MCP_RESOURCE_TEMPLATES } from "../resources";
import { prisma } from "@/lib/db";
import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import { getLabHistory } from "@/lib/mcp/rich-reads";
import { listTargetsBySource } from "@/lib/links";
import type { McpAuthContext } from "../auth";

const CTX: McpAuthContext = {
  userId: "u1",
  tokenId: "t",
  scopes: ["health:read"],
  binding: "u1:t",
  canRead: true,
  canWrite: false,
};

const OFF = { present: false, reason: "module_disabled" };

const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!;
const template = (name: string) =>
  MCP_RESOURCE_TEMPLATES.find((t) => t.name === name)!;
const resource = (uri: string) => MCP_RESOURCES.find((r) => r.uri === uri)!;

beforeEach(() => {
  vi.clearAllMocks();
  disabled.clear();
});

describe("labs switched off", () => {
  beforeEach(() => disabled.add("labs"));

  it("get_labs refuses in both modes without reading", async () => {
    expect(await tool("get_labs").run(CTX, {})).toEqual(OFF);
    expect(
      await tool("get_labs").run(CTX, { analyte: "LDL", history: true }),
    ).toEqual(OFF);
    expect(executeCoachTool).not.toHaveBeenCalled();
    expect(getLabHistory).not.toHaveBeenCalled();
  });

  it("the lab resource template reads, lists and completes nothing", async () => {
    const lab = template("lab");
    expect(await lab.read(CTX, { analyte: "LDL" })).toEqual(OFF);
    expect(await lab.list!(CTX)).toEqual([]);
    expect(await lab.complete!.analyte(CTX, "L")).toEqual([]);
    expect(prisma.labResult.findMany).not.toHaveBeenCalled();
  });
});

describe("medications switched off", () => {
  beforeEach(() => disabled.add("medications"));

  it("the schedule and compliance tools refuse without reading", async () => {
    expect(await tool("get_medication_schedule").run(CTX, {})).toEqual(OFF);
    expect(await tool("get_medication_compliance").run(CTX, {})).toEqual(OFF);
    expect(prisma.medication.findMany).not.toHaveBeenCalled();
    expect(executeCoachTool).not.toHaveBeenCalled();
  });

  it("the medication resources read and list nothing", async () => {
    const med = template("medication");
    expect(await med.read(CTX, { id: "m-1" })).toEqual(OFF);
    expect(await med.list!(CTX)).toEqual([]);
    expect(await resource("healthlog://medications").read(CTX)).toEqual(OFF);
    expect(prisma.medication.findMany).not.toHaveBeenCalled();
    expect(prisma.medication.findFirst).not.toHaveBeenCalled();
  });
});

describe("environment switched off (v1.42)", () => {
  beforeEach(() => disabled.add("environment"));

  it("get_environment refuses without reading", async () => {
    expect(await tool("get_environment").run(CTX, {})).toEqual(OFF);
    expect(
      await tool("get_environment").run(CTX, { window: "lastYear" }),
    ).toEqual(OFF);
    expect(executeCoachTool).not.toHaveBeenCalled();
  });
});

describe("modules on", () => {
  it("the same reads still answer", async () => {
    await tool("get_labs").run(CTX, {});
    await tool("get_medication_compliance").run(CTX, {});
    await tool("get_environment").run(CTX, {});
    expect(executeCoachTool).toHaveBeenCalledTimes(3);
    expect(await template("lab").list!(CTX)).toHaveLength(1);
    expect(await template("medication").list!(CTX)).toHaveLength(1);
  });
});

describe("get_visits", () => {
  it("drops condition labels when illness is off, and says so", async () => {
    disabled.add("illness");
    const result = (await tool("get_visits").run(CTX, {})) as {
      present: boolean;
      conditionsReason?: string;
      visits: Array<{ conditions: string[] }>;
    };
    expect(result.present).toBe(true);
    expect(result.conditionsReason).toBe("module_disabled");
    expect(result.visits[0].conditions).toEqual([]);
    expect(listTargetsBySource).not.toHaveBeenCalled();
  });

  it("keeps condition labels when illness is on", async () => {
    const result = (await tool("get_visits").run(CTX, {})) as {
      conditionsReason?: string;
      visits: Array<{ conditions: string[] }>;
    };
    expect(result.conditionsReason).toBeUndefined();
    expect(result.visits[0].conditions).toEqual(["Knee pain"]);
  });

  it("does not name a deleted practitioner", async () => {
    const result = (await tool("get_visits").run(CTX, {})) as {
      visits: Array<{ practitioner: string | null; specialty: string | null }>;
    };
    expect(result.visits[0].practitioner).toBeNull();
    expect(result.visits[0].specialty).toBeNull();
  });
});
