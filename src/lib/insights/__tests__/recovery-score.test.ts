/**
 * v1.10.0 — computed scores (WX-C). Recovery-score engine + persistence.
 *
 * The engine reuses the READINESS derived blend (mocked here) and writes a
 * `COMPUTED RECOVERY_SCORE` row. These tests pin:
 *   - the per-day idempotency-key + canonical-timestamp helpers,
 *   - the "store on ok, write nothing on insufficient" gate,
 *   - the upsert shape (idempotent per user per day).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Derived } from "@/lib/insights/derived/types";
import type { ReadinessValue } from "@/lib/insights/derived/readiness";

/**
 * The post-mutation tail reads the real `@/lib/db` client, not the fake this
 * file injects, so a stored score opened a socket to a Postgres the unit job
 * does not run. The attempt failed a few hundred milliseconds later and logged
 * on the way out — after the test that started it had ended — which is how a
 * green file tore its worker's RPC channel down mid-write. Stubbed here;
 * `score-row.test.ts` asserts the wiring this stands for.
 */
vi.mock("@/lib/rollups/after-measurement-mutation", () => ({
  afterMeasurementMutation: vi.fn(async () => {}),
}));

const computeReadinessMock =
  vi.fn<(...args: unknown[]) => Promise<Derived<ReadinessValue>>>();

vi.mock("@/lib/insights/derived/readiness", () => ({
  computeReadiness: (...args: unknown[]) => computeReadinessMock(...args),
}));

// v1.18.1 P4 — Rest Mode resolver. Default inactive; the annotation test
// flips it active to assert the score is NOT penalised, only annotated.
const restModeMock = vi.hoisted(() => ({
  resolveRestMode: vi.fn(async () => ({
    active: false as boolean,
    since: null as string | null,
    episodeCount: 0,
    episodes: [] as unknown[],
  })),
}));
vi.mock("@/lib/illness/rest-mode", () => restModeMock);

import {
  recoveryDayKey,
  recoveryExternalId,
  recoveryMeasuredAt,
  computeRecoveryScore,
  persistRecoveryScore,
  loadRecoveryProfile,
  RECOVERY_SCORE_EXTERNAL_ID_PREFIX,
} from "../recovery-score";

const NOW = new Date("2026-06-02T08:30:00Z");

function okReadiness(score: number): Derived<ReadinessValue> {
  return {
    status: "ok",
    value: { score, band: "green", components: [] },
    coverage: {
      requiredInputs: 5,
      presentInputs: 4,
      historyDays: 30,
      missing: [],
    },
    confidence: { score: 80, band: "high" },
    provenance: {
      inputs: [],
      source: "DAY",
      windowDays: 30,
      computedAt: NOW.toISOString(),
    },
  };
}

function insufficientReadiness(): Derived<ReadinessValue> {
  return {
    status: "insufficient",
    coverage: {
      requiredInputs: 5,
      presentInputs: 1,
      historyDays: 0,
      missing: ["hrv"],
    },
    provenance: {
      inputs: [],
      source: "none",
      windowDays: 30,
      computedAt: NOW.toISOString(),
    },
    reason: "insufficient_components",
  };
}

function makePrisma() {
  const upsert = vi.fn().mockResolvedValue({});
  const findUnique = vi
    .fn()
    .mockResolvedValue({ dateOfBirth: null, gender: "MALE", heightCm: 180 });
  return {
    prisma: {
      measurement: { upsert },
      user: { findUnique },
    } as unknown as Parameters<typeof persistRecoveryScore>[0],
    upsert,
    findUnique,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  restModeMock.resolveRestMode.mockResolvedValue({
    active: false,
    since: null,
    episodeCount: 0,
    episodes: [],
  });
});

describe("recovery-score helpers", () => {
  it("scores the PREVIOUS UTC day (cron fires in the small hours)", () => {
    // NOW is 2026-06-02 → the scored day is the just-completed 2026-06-01.
    expect(recoveryDayKey(NOW)).toBe("2026-06-01");
    expect(recoveryExternalId(NOW)).toBe(
      `${RECOVERY_SCORE_EXTERNAL_ID_PREFIX}2026-06-01`,
    );
  });

  it("anchors the canonical timestamp at noon UTC on the scored (previous) day", () => {
    expect(recoveryMeasuredAt(NOW).toISOString()).toBe(
      "2026-06-01T12:00:00.000Z",
    );
  });
});

describe("computeRecoveryScore — Rest Mode annotation (v1.18.1 P4)", () => {
  const profile = {} as Parameters<typeof computeRecoveryScore>[2];

  it("annotates an active episode WITHOUT penalising the score", async () => {
    // A genuinely low recovery blend (40) — the kind a low day produces.
    computeReadinessMock.mockResolvedValue(okReadiness(40));
    restModeMock.resolveRestMode.mockResolvedValue({
      active: true,
      since: "2026-05-30T00:00:00.000Z",
      episodeCount: 1,
      episodes: [],
    });
    const { prisma } = makePrisma();
    const result = await computeRecoveryScore(prisma, "u1", profile, NOW);
    // The raw blend is reported verbatim — Rest Mode does not adjust it.
    expect(result.score).toBe(40);
    // …but the context is attached so the surface can frame it.
    expect(result.restMode.active).toBe(true);
    expect(result.restMode.since).toBe("2026-05-30T00:00:00.000Z");
  });

  it("carries the inactive context when no episode is active", async () => {
    computeReadinessMock.mockResolvedValue(okReadiness(80));
    const { prisma } = makePrisma();
    const result = await computeRecoveryScore(prisma, "u1", profile, NOW);
    expect(result.score).toBe(80);
    expect(result.restMode.active).toBe(false);
  });

  // Keep `loadRecoveryProfile` referenced so the named import stays exercised.
  it("exposes loadRecoveryProfile", () => {
    expect(typeof loadRecoveryProfile).toBe("function");
  });
});

describe("persistRecoveryScore", () => {
  it("stores a COMPUTED RECOVERY_SCORE row when the blend is ok", async () => {
    const { prisma, upsert } = makePrisma();
    computeReadinessMock.mockResolvedValue(okReadiness(72));

    const result = await persistRecoveryScore(prisma, "user-1", NOW);

    expect(result).toEqual({ outcome: "stored", score: 72 });
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where.userId_type_source_externalId).toEqual({
      userId: "user-1",
      type: "RECOVERY_SCORE",
      source: "COMPUTED",
      externalId: "recovery:2026-06-01",
    });
    expect(arg.create).toMatchObject({
      userId: "user-1",
      type: "RECOVERY_SCORE",
      source: "COMPUTED",
      value: 72,
      unit: "score",
      externalId: "recovery:2026-06-01",
    });
    expect(arg.update).toMatchObject({ value: 72 });
  });

  it("writes NOTHING when the readiness blend is insufficient", async () => {
    const { prisma, upsert } = makePrisma();
    computeReadinessMock.mockResolvedValue(insufficientReadiness());

    const result = await persistRecoveryScore(prisma, "user-1", NOW);

    expect(result).toEqual({ outcome: "insufficient", score: null });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is idempotent per user per day — re-runs upsert the same key", async () => {
    const { prisma, upsert } = makePrisma();
    computeReadinessMock.mockResolvedValue(okReadiness(64));

    await persistRecoveryScore(prisma, "user-1", NOW);
    await persistRecoveryScore(prisma, "user-1", NOW);

    expect(upsert).toHaveBeenCalledTimes(2);
    const firstKey =
      upsert.mock.calls[0][0].where.userId_type_source_externalId;
    const secondKey =
      upsert.mock.calls[1][0].where.userId_type_source_externalId;
    expect(secondKey).toEqual(firstKey);
  });
});
