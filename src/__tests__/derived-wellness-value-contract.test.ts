/**
 * The published `WellnessScoreValue` schema against the value the engine
 * actually returns.
 *
 * `GET /api/insights/derived` types its `value` as an open record — one
 * envelope carries eighteen differently-shaped metrics, so no single `$ref`
 * fits — which meant every metric's payload shape was undocumented and a
 * client had to inspect a live response to learn what was in it. The three
 * wellness scores are modelled now, published through the forced-components
 * slot, and this holds the published shape to the runtime one: a field added
 * to the engine and not to the schema, or the reverse, fails here rather than
 * shipping as a spec that describes a payload nobody sends.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    strainTrimpCache: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue({ timezone: "UTC" }) },
  },
}));
vi.mock("@/lib/insights/derived/readiness", () => ({
  computeReadiness: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { computeReadiness } from "@/lib/insights/derived/readiness";
import { computeWellnessScore } from "@/lib/insights/derived/wellness-scores";
import { wellnessScoreValue } from "@/lib/openapi/routes/insights/schemas";
import { openApiComponents } from "@/lib/openapi/routes";

const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;
const NOW = new Date("2026-06-02T08:00:00Z");
const PROFILE = { ageYears: 40, sex: "MALE" as const };

beforeEach(() => {
  vi.mocked(computeReadiness).mockResolvedValue({
    status: "ok",
    value: {
      score: 74,
      band: "green",
      components: [
        { key: "rhr", value: 90, weight: 0.5 },
        { key: "hrv", value: null, weight: 0 },
      ],
    },
  } as never);
});

describe("published WellnessScoreValue", () => {
  it("is registered as a component even though nothing $refs it", () => {
    expect(openApiComponents.schemas).toHaveProperty("WellnessScoreValue");
    expect(openApiComponents.schemas?.WellnessScoreValue).toBe(
      wellnessScoreValue,
    );
  });

  it("accepts the recovery value the engine emits, field for field", async () => {
    findMany.mockResolvedValue([
      {
        value: 72.4,
        measuredAt: new Date("2026-06-01T12:00:00Z"),
        source: "COMPUTED",
      },
      {
        value: 60,
        measuredAt: new Date("2026-05-31T12:00:00Z"),
        source: "COMPUTED",
      },
    ]);
    const derived = await computeWellnessScore(
      "RECOVERY_SCORE",
      "u1",
      PROFILE,
      { now: NOW },
    );
    expect(derived.status).toBe("ok");
    if (derived.status !== "ok") return;

    const parsed = wellnessScoreValue.safeParse(derived.value);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);

    // Not just "parses" — the published field list and the emitted one are the
    // same set. A permissive schema would pass the parse above while quietly
    // omitting a field, which is the failure this whole change is about.
    expect(Object.keys(wellnessScoreValue.shape).sort()).toEqual(
      Object.keys(derived.value as unknown as Record<string, unknown>).sort(),
    );
  });

  it("accepts the strain value, whose anchor the other two never carry", async () => {
    findMany.mockResolvedValue([
      {
        value: 55,
        measuredAt: new Date("2026-06-01T12:00:00Z"),
        source: "COMPUTED",
      },
    ]);
    vi.mocked(prisma.strainTrimpCache.findUnique).mockResolvedValue({
      anchor: "personal",
    } as never);
    const derived = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(derived.status).toBe("ok");
    if (derived.status !== "ok") return;
    const parsed = wellnessScoreValue.safeParse(derived.value);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(Object.keys(wellnessScoreValue.shape).sort()).toEqual(
      Object.keys(derived.value as unknown as Record<string, unknown>).sort(),
    );
  });

  it("accepts the strain value served from the device's day strain", async () => {
    findMany.mockImplementation(async (args: { where: { type: string } }) =>
      args.where.type === "DAY_STRAIN"
        ? [
            {
              value: 12.6,
              measuredAt: new Date("2026-06-01T04:00:00Z"),
              source: "WHOOP",
            },
          ]
        : [],
    );
    const derived = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(derived.status).toBe("ok");
    if (derived.status !== "ok") return;
    const parsed = wellnessScoreValue.safeParse(derived.value);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(Object.keys(wellnessScoreValue.shape).sort()).toEqual(
      Object.keys(derived.value as unknown as Record<string, unknown>).sort(),
    );
    findMany.mockReset();
  });
});
