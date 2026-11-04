/**
 * `GET /api/dashboard/summary` — module gate.
 *
 * This route builds its own payload instead of going through
 * `readDashboardSnapshotCached`, so it never picked up the gate the shared
 * snapshot builder applies: it emitted glucose and sleep cards on data
 * presence alone while `/api/dashboard/snapshot` correctly withheld them for
 * the very same account.
 *
 * OMIT, not 403 — the payload spans ten metric cards across several domains,
 * and blanking an iOS dashboard because one module is off would be the wrong
 * trade. Core vitals must keep flowing.
 *
 * Behavioural: the assertions read the emitted card list, so reverting the
 * filter in the route turns them red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
// The gate resolver runs for real; only its data sources are stubbed, so the
// module state is driven the way production drives it.
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    cycleProfile: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/modules/operator-availability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/modules/operator-availability")
    >();
  return { ...actual, getOperatorModuleAvailability: vi.fn() };
});
vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feature-flags")>()),
  ...(
    await import("@/__tests__/helpers/assistant-switches-mock")
  ).mockAssistantSwitches(vi.fn()),
}));
// The heavy builder is stubbed: this test pins the GATE, not the aggregate
// (which has its own coverage). It returns one card per emitted kind.
vi.mock("@/lib/cache/server-cache", () => ({
  caches: { analytics: {} },
  cachedSwr: vi.fn(),
}));
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
import { cachedSwr } from "@/lib/cache/server-cache";
import { MODULE_KEYS } from "@/lib/modules/gate";
import { getOperatorModuleAvailability } from "@/lib/modules/operator-availability";
import { getAssistantFlags } from "@/lib/feature-flags";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    displayName: null,
    locale: "en",
    timezone: "UTC",
  },
};

/** Every card kind the builder can emit, one card each. */
const ALL_KINDS = [
  "weight",
  "bloodPressure",
  "pulse",
  "bodyFat",
  "glucose",
  "sleep",
  "steps",
  "totalBodyWater",
  "boneMass",
  "oxygenSaturation",
  "mood",
  "bmi",
] as const;

function card(kind: string) {
  return {
    id: kind,
    kind,
    titleKey: `dashboard.metric.title.${kind}`,
    latestValue: 1,
    secondaryValue: null,
    unitKey: `dashboard.metric.unit.${kind}`,
    unit: null,
    sleepStages: null,
    sleepSourceDiscrepancy: null,
    trend: "flat",
    sparkline: [1],
    updatedAt: new Date().toISOString(),
    allTimeCount: 5,
    lastSeenAt: new Date().toISOString(),
  };
}

/** Drive the real gate through the persisted disabled-allowlist. */
function setDisabledModules(disabled: string[]): void {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    gender: null,
    disableCoach: false,
    modulePreferencesJson: Object.fromEntries(disabled.map((k) => [k, false])),
  } as never);
  vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(null as never);
}

async function emittedKinds(): Promise<string[]> {
  const res = await GET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { metrics: Array<{ kind: string }> };
  };
  return body.data.metrics.map((m) => m.kind);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(getOperatorModuleAvailability).mockResolvedValue(
    Object.fromEntries(MODULE_KEYS.map((k) => [k, true])) as never,
  );
  vi.mocked(getAssistantFlags).mockResolvedValue({ coach: true } as never);
  vi.mocked(cachedSwr).mockImplementation((async () => ({
    greeting: { salutation: "hi", date: new Date().toISOString() },
    streak: { currentDays: 0, longest: 0, label: "" },
    compliance: { scheduledToday: 0, takenToday: 0 },
    highlightInsight: null,
    metrics: ALL_KINDS.map(card),
    sleepRhythm: null,
    lastUpdated: new Date().toISOString(),
  })) as never);
});

describe("GET /api/dashboard/summary — module gate", () => {
  it("emits every card when no module is disabled", async () => {
    setDisabledModules([]);
    expect(await emittedKinds()).toEqual([...ALL_KINDS]);
  });

  it("drops the glucose card when the glucose module is off", async () => {
    setDisabledModules(["glucose"]);
    const kinds = await emittedKinds();

    expect(kinds).not.toContain("glucose");
    // Everything else survives — proves an omission, not a refusal.
    expect(kinds).toContain("weight");
    expect(kinds).toContain("sleep");
    expect(kinds).toHaveLength(ALL_KINDS.length - 1);
  });

  it("drops the sleep card when the sleep module is off", async () => {
    setDisabledModules(["sleep"]);
    const kinds = await emittedKinds();

    expect(kinds).not.toContain("sleep");
    expect(kinds).toContain("glucose");
    expect(kinds).toHaveLength(ALL_KINDS.length - 1);
  });

  it("drops both when both modules are off", async () => {
    setDisabledModules(["glucose", "sleep"]);
    const kinds = await emittedKinds();

    expect(kinds).not.toContain("glucose");
    expect(kinds).not.toContain("sleep");
    expect(kinds).toHaveLength(ALL_KINDS.length - 2);
  });

  it("never drops a core vital, whatever is disabled", async () => {
    // Core metrics carry no SUMMARY_TYPE_MODULE entry and must always ship.
    setDisabledModules([...MODULE_KEYS]);
    const kinds = await emittedKinds();

    for (const core of [
      "weight",
      "bloodPressure",
      "pulse",
      "bodyFat",
      "steps",
      "totalBodyWater",
      "boneMass",
      "oxygenSaturation",
      // BMI is derived from weight + the profile height and belongs to no
      // module, so it rides through with the other core vitals.
      "bmi",
    ]) {
      expect(kinds).toContain(core);
    }
  });

  it("drops the mood card when the mood module is off", async () => {
    // Mood is not a MeasurementType, so it gates through the synthetic
    // `MOOD_ENTRY` key rather than a measurement enum value. Without that
    // join the card would be unmapped and silently ship past a disabled
    // module.
    setDisabledModules(["mood"]);
    const kinds = await emittedKinds();

    expect(kinds).not.toContain("mood");
    expect(kinds).toContain("weight");
    expect(kinds).toContain("bmi");
    expect(kinds).toHaveLength(ALL_KINDS.length - 1);
  });

  it("gates the cached body, so a toggle takes effect on the next request", async () => {
    // The analytics LRU is not evicted by a module toggle. The filter must
    // therefore run on the way out, not inside the cached build.
    setDisabledModules([]);
    expect(await emittedKinds()).toContain("glucose");

    // Same cached body, module now off.
    setDisabledModules(["glucose"]);
    expect(await emittedKinds()).not.toContain("glucose");
  });
});
