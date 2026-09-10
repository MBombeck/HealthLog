/**
 * What a cycle-only delegate learns from `GET /api/cycle/insights`.
 *
 * The route is declared `("read", "cycle")`, and everything about the phase
 * labels belongs there. Its outcome columns do not: `lutealAvg`,
 * `follicularAvg` and `delta` carry resting heart rate, HRV, sleep, steps,
 * weight, temperature, glucose and the mood score in display units, and those
 * are `measurements` and `mind` data reached through a cycle grant.
 *
 * So two properties, both about somebody holding `["cycle"]` and nothing else:
 *
 *   1. **No foreign figure crosses the seam.** No row whose `metricKey` names
 *      a measurement channel, no mood row, and no lagged discovery built out
 *      of either.
 *   2. **The cycle-native answer still arrives.** The symptom-by-phase
 *      patterns are cycle data and stay, so the fix is a fence rather than a
 *      blanket refusal.
 *
 * The unscoped grant is asserted in the same fixture, because a change that
 * hid the figures from everyone would satisfy the first property and break
 * the feature.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { ShareDomain } from "@/lib/sharing/scope";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const OWNER_ID = "cycle-insights-owner";
const DELEGATE_ID = "cycle-insights-delegate";

/** Cycle geometry the fixture logs, chosen so both phases clear the day floor. */
const CYCLE_LENGTH = 28;
const PERIOD_LENGTH = 5;
const OBSERVED_CYCLES = 5;

function isoDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function atNoon(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

/** Sign in as the delegate and switch into the owner's record. */
async function switchInto(scope: ShareDomain[] | null) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: OWNER_ID,
    granteeId: DELEGATE_ID,
    access: "READ",
    scope,
  });
  await acceptGrant({ grantId: invited.id, granteeId: DELEGATE_ID });
  const session = await signIn(DELEGATE_ID);
  await switchSessionTo(session.id, OWNER_ID);
}

/**
 * Five observed cycles, then a weight and a mood value on every labelled day
 * whose size depends on the phase.
 *
 * The separation is deliberately huge (80 kg vs 70 kg, mood 2 vs 4) so the
 * Welch + Benjamini-Hochberg gate the route runs cannot be the reason a row is
 * missing: with this fixture a missing row means the fence removed it.
 */
async function seedRecord() {
  const prisma = getPrismaClient();
  for (const [id, name] of [
    [OWNER_ID, "owner"],
    [DELEGATE_ID, "delegate"],
  ] as const) {
    await prisma.user.create({
      data: {
        id,
        username: `cycle-insights-${name}`,
        email: `cycle-insights-${name}@example.test`,
        gender: "FEMALE",
        timezone: "UTC",
      },
    });
  }

  // Prediction off, so the phase map the route builds is the one this fixture
  // can reproduce from the logged cycles alone.
  await prisma.cycleProfile.create({
    data: {
      userId: OWNER_ID,
      cycleTrackingEnabled: true,
      predictionEnabled: false,
      lutealPhaseLength: 14,
    },
  });

  const starts: string[] = [];
  for (let i = OBSERVED_CYCLES; i >= 1; i--) {
    starts.push(isoDay(-i * CYCLE_LENGTH));
  }
  for (const [index, startDate] of starts.entries()) {
    const next = starts[index + 1] ?? null;
    await prisma.menstrualCycle.create({
      data: {
        userId: OWNER_ID,
        startDate,
        endDate: next
          ? isoDay(-(OBSERVED_CYCLES - index) * CYCLE_LENGTH - 1 + CYCLE_LENGTH)
          : null,
        periodEndDate: isoDay(
          -(OBSERVED_CYCLES - index) * CYCLE_LENGTH + PERIOD_LENGTH - 1,
        ),
        ovulationDate: isoDay(
          -(OBSERVED_CYCLES - index) * CYCLE_LENGTH + CYCLE_LENGTH - 15,
        ),
        tz: "UTC",
      },
    });
  }

  const { buildPhaseDayMap } = await import("@/lib/cycle/engine-adapter");
  const cycles = await prisma.menstrualCycle.findMany({
    where: { userId: OWNER_ID },
    orderBy: { startDate: "asc" },
  });
  const today = isoDay(0);
  const phaseByDay = buildPhaseDayMap(
    cycles,
    null,
    14,
    isoDay(-OBSERVED_CYCLES * CYCLE_LENGTH),
    today,
    today,
  );

  let luteal = 0;
  let follicular = 0;
  for (const [day, phase] of phaseByDay) {
    if (phase !== "LUTEAL" && phase !== "FOLLICULAR") continue;
    const high = phase === "LUTEAL";
    if (high) luteal++;
    else follicular++;
    // A little jitter in both channels, so the Welch test has a variance to
    // work with and the row is not dropped for a reason the fence did not
    // cause.
    const jitter = ((luteal + follicular) % 3) * 0.1;
    await prisma.measurement.create({
      data: {
        userId: OWNER_ID,
        type: "WEIGHT",
        value: (high ? 80 : 70) + jitter,
        unit: "kg",
        measuredAt: atNoon(day),
      },
    });
    await prisma.moodEntry.create({
      data: {
        userId: OWNER_ID,
        mood: high ? "SCHLECHT" : "GUT",
        score: (high ? 1 : 4) + ((luteal + follicular) % 2),
        date: day,
        moodLoggedAt: atNoon(day),
        tz: "UTC",
      },
    });
  }

  expect(
    luteal,
    "the fixture labels enough luteal days to clear the crosstab floor",
  ).toBeGreaterThanOrEqual(5);
  expect(
    follicular,
    "the fixture labels enough follicular days to clear the crosstab floor",
  ).toBeGreaterThanOrEqual(5);
}

interface InsightsBody {
  rows: Array<{ metricKey: string }>;
  headline: { metricKey: string } | null;
  lagged: { discovered: unknown[] };
  symptomPatterns: unknown[];
}

async function readInsights(): Promise<InsightsBody> {
  const { GET } = await import("@/app/api/cycle/insights/route");
  // The handler declares no parameters; the wrapper still reads the request
  // off its first argument, and the method it carries is what the record
  // resolver escalates on.
  const handler = GET as unknown as (request: Request) => Promise<Response>;
  const res = await handler(new Request("http://localhost/api/cycle/insights"));
  expect(res.status).toBe(200);
  const parsed = (await res.json()) as { data: InsightsBody };
  return parsed.data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedRecord();
});

describe("cycle insights fence the sections it reads across", () => {
  it("gives the owner the measurement and the mood contrast", async () => {
    await signIn(OWNER_ID);
    const body = await readInsights();

    const keys = body.rows.map((row) => row.metricKey);
    expect(keys, "the weight contrast is the fixture's whole point").toContain(
      "weight",
    );
    expect(keys, "and the mood contrast beside it").toContain("mood");
  });

  it("gives an entire-record delegate the same figures", async () => {
    await switchInto(null);
    const body = await readInsights();

    const keys = body.rows.map((row) => row.metricKey);
    expect(keys).toContain("weight");
    expect(keys).toContain("mood");
  });

  it("gives a cycle-only delegate no measurement and no mood figure", async () => {
    await switchInto(["cycle"]);
    const body = await readInsights();

    expect(
      body.rows,
      "every crosstab row is a measurement or a mood column",
    ).toHaveLength(0);
    expect(body.headline).toBeNull();
    expect(
      body.lagged.discovered,
      "the lagged matrix is built from the same two sections",
    ).toHaveLength(0);
  });

  it("gives a cycle+mind delegate the mood figure and not the weight", async () => {
    await switchInto(["cycle", "mind"]);
    const body = await readInsights();

    const keys = body.rows.map((row) => row.metricKey);
    expect(
      keys,
      "mind is held, so the mood column is within the grant",
    ).toContain("mood");
    expect(keys, "measurements is not held").not.toContain("weight");
  });
});
