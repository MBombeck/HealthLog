/**
 * v1.34.0 — integration coverage for the analytics route's versioned
 * reference-composite Health Score (`src/lib/analytics/score/**`).
 *
 * Replaces the pre-v1.34.0 weighted bp/weight/mood/compliance shape this
 * file used to pin. That scorer, its `components.*` envelope, and its
 * mood/compliance pillars are gone; the current score reads coverage- and
 * provenance-tagged pillars (BLOOD_PRESSURE, GLYCAEMIA, ACTIVITY, SLEEP,
 * ADIPOSITY, WELLBEING, FITNESS, LIPIDS) through a real Postgres round trip
 * of `GET /api/analytics`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface PillarEnvelope {
  id: string;
  domain: string;
  result: {
    status: "ok" | "insufficient";
    reason?: string;
    value?: {
      score: number;
      observed: { value: number };
      scoreBasis?: {
        axis: string;
        relation: string;
        offsetMmHg: number;
        boundaryMmHg: number;
      };
      personalReference?: { label: string };
    };
  };
}

interface AnalyticsEnvelope {
  data: {
    healthScore: {
      composite: {
        status: "ok" | "insufficient";
        reason?: string;
        value?: {
          score: number;
          band: "green" | "yellow" | "red";
          // Not to be confused with a pillar's `scoreBasis`, which explains
          // which axis set that pillar's number. This one says how much of
          // the record the composite rests on.
          scoreBasis?: {
            domains: number;
            recommended: number;
            tier: "full" | "partial" | "minimal";
            physiological: boolean;
          };
        };
      };
      pillars: PillarEnvelope[];
    } | null;
  } | null;
  error?: string | null;
}

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      heightCm: 178,
      dateOfBirth: new Date("1985-07-09"),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

/**
 * BP pillar requires `BLOOD_PRESSURE_MIN_PAIRS` (12) paired readings inside
 * the trailing 90-day window read through the same fast-path aggregator the
 * BP-in-target tile uses.
 */
async function seedInTargetBp(userId: string, now: number, days: number) {
  const prisma = getPrismaClient();
  const DAY = 24 * 60 * 60 * 1000;
  for (let i = 0; i < days; i++) {
    const at = new Date(now - i * DAY);
    await prisma.measurement.create({
      data: {
        userId,
        type: "BLOOD_PRESSURE_SYS",
        value: 122,
        unit: "mmHg",
        measuredAt: at,
      },
    });
    await prisma.measurement.create({
      data: {
        userId,
        type: "BLOOD_PRESSURE_DIA",
        value: 78,
        unit: "mmHg",
        measuredAt: at,
      },
    });
  }
}

/** SLEEP pillar requires `SLEEP_MIN_NIGHTS` (14) distinct wake-day nights. */
async function seedSleepNights(userId: string, now: number, nights: number) {
  const prisma = getPrismaClient();
  const DAY = 24 * 60 * 60 * 1000;
  for (let i = 0; i < nights; i++) {
    const wake = new Date(now - i * DAY);
    wake.setUTCHours(6, 0, 0, 0);
    await prisma.measurement.create({
      data: {
        userId,
        type: "SLEEP_DURATION",
        value: 450,
        unit: "min",
        measuredAt: wake,
        sleepStage: "ASLEEP",
        source: "APPLE_HEALTH",
      },
    });
  }
}

/** ADIPOSITY pillar needs one waist-circumference reading plus a height. */
async function seedWaist(userId: string, now: number) {
  const prisma = getPrismaClient();
  await prisma.measurement.create({
    data: {
      userId,
      type: "WAIST_CIRCUMFERENCE",
      value: 82,
      unit: "cm",
      measuredAt: new Date(now),
    },
  });
}

describe("GET /api/analytics — Health Score (v1.34 reference composite)", () => {
  it("grades a composite from a strong three-domain synthetic shape", async () => {
    const user = await seedSession("hs-strong");
    const now = Date.now();

    await seedInTargetBp(user.id, now, 20);
    await seedSleepNights(user.id, now, 14);
    await seedWaist(user.id, now);

    const { GET } = await import("@/app/api/analytics/route");
    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as AnalyticsEnvelope;
    expect(env.data).not.toBeNull();
    const hs = env.data!.healthScore!;
    expect(hs).not.toBeNull();
    expect(hs.composite.status).toBe("ok");
    expect(hs.composite.value!.score).toBeGreaterThanOrEqual(75);
    expect(hs.composite.value!.band).toBe("green");

    // Every seeded pillar graded, not just the ones the composite counted.
    const byId = new Map(hs.pillars.map((p) => [p.id, p]));
    expect(byId.get("BLOOD_PRESSURE")!.result.status).toBe("ok");
    expect(byId.get("SLEEP")!.result.status).toBe("ok");
    expect(byId.get("ADIPOSITY")!.result.status).toBe("ok");
  });

  it("scores the BP pillar from the trailing-90-day window when readings predate the last 30 days", async () => {
    // v1.17 W1d regression pin, carried forward: the BD-Zielbereich tile
    // headline, the Health-Score BP pillar and the coach number all read the
    // SAME trailing-90-day window. Readings 60-80 days ago sit OUTSIDE the
    // trailing 30 days but INSIDE the 90-day window the pillar and the
    // headline share.
    const user = await seedSession("hs-bp-old");
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const prisma = getPrismaClient();

    for (let i = 0; i < 20; i++) {
      const at = new Date(now - (60 + i) * DAY);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: 122,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: 78,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    const { GET } = await import("@/app/api/analytics/route");
    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as AnalyticsEnvelope & {
      data: { bpInTargetPct: number | null } | null;
    };
    const hs = env.data!.healthScore!;
    const bp = hs.pillars.find((p) => p.id === "BLOOD_PRESSURE")!;
    expect(bp.result.status).toBe("ok");
    expect(bp.result.value!.score).toBeGreaterThanOrEqual(80);
    // …and the tile headline reads the SAME 90-day window, so it surfaces
    // the in-target rate (all 20 pairs in target) rather than dropping to
    // null. The pillar and the headline stay unified on the window.
    expect(env.data!.bpInTargetPct).toBe(100);
  });

  it("reports an explicit insufficient composite for a user with no data", async () => {
    await seedSession("hs-empty");
    const { GET } = await import("@/app/api/analytics/route");
    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as AnalyticsEnvelope;
    const hs = env.data!.healthScore!;
    // v1.34 — the reference composite always returns a structured report,
    // even with zero data; it reads as an explicit "insufficient" status,
    // never a bare null.
    expect(hs).not.toBeNull();
    expect(hs.composite.status).toBe("insufficient");
    expect(hs.composite.value).toBeUndefined();
  });

  it("delivers the BP score basis to the client from the same run that produced the score", async () => {
    // v1.34.5 — the popover explains "why 56" from a server-resolved basis.
    // The basis and the score must come from ONE grading run: the route
    // deliberately re-runs the BP helper against the CLINICAL band when the
    // user keeps a personal target, and a basis taken from the other run
    // would explain a number nobody is looking at.
    //
    // This asserts through the REAL route and the REAL JSON response, not a
    // hand-built payload, because the assembly between the grader and the
    // client is exactly where a correct field goes missing.
    const user = await seedSession("hs-bp-basis");
    const prisma = getPrismaClient();
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // A personal band that is WIDER than the clinical one on both axes, so
    // the two runs disagree about everything the basis carries:
    //   clinical 129/79 → diastolic binds, 9 mmHg over its 79 ceiling → 55
    //   personal 135/90 → both axes in band                          → 88
    await prisma.user.update({
      where: { id: user.id },
      data: {
        thresholdsJson: {
          BLOOD_PRESSURE_SYS: { min: 120, max: 135 },
          BLOOD_PRESSURE_DIA: { min: 70, max: 90 },
        },
      },
    });
    for (let i = 0; i < 20; i++) {
      const at = new Date(now - i * DAY);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: 132,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: 88,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    const { GET } = await import("@/app/api/analytics/route");
    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as AnalyticsEnvelope;
    const bp = env.data!.healthScore!.pillars.find(
      (p) => p.id === "BLOOD_PRESSURE",
    )!;
    expect(bp.result.status).toBe("ok");

    // The personal band reached the payload, so the route really did take
    // the branch that re-grades against the clinical one.
    expect(bp.result.value!.personalReference!.label).toContain("135");

    // Score AND basis, both from the clinical run: the diastolic axis, nine
    // over ITS clinical ceiling of 79. Under the personal band the same
    // readings sit inside it and score 88 — so a basis sourced from that
    // second run cannot pass here.
    expect(bp.result.value!.score).toBe(55);
    expect(bp.result.value!.scoreBasis).toEqual({
      axis: "diastolic",
      relation: "above_ceiling",
      offsetMmHg: 9,
      boundaryMmHg: 79,
    });
  });

  it("grades two eligible domains as a partial score over the wire", async () => {
    // This case used to assert a refusal: two graded pillars in two areas
    // fell under the three-domain floor and the whole composite went dark,
    // which is what someone who keeps sleep and waist saw for as long as
    // they kept only those two. The floor is now a recommendation, so the
    // same fixture scores and says what it rests on. Asserted end to end
    // rather than on the composite alone, because the basis has to survive
    // the route's serialisation to be worth anything to a client.
    const user = await seedSession("hs-two-domains");
    const now = Date.now();

    await seedSleepNights(user.id, now, 14);
    await seedWaist(user.id, now);

    const { GET } = await import("@/app/api/analytics/route");
    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as AnalyticsEnvelope;
    const hs = env.data!.healthScore!;
    expect(hs.composite.status).toBe("ok");
    expect(hs.composite.value!.scoreBasis).toEqual({
      domains: 2,
      recommended: 3,
      tier: "partial",
      physiological: true,
    });
    const byId = new Map(hs.pillars.map((p) => [p.id, p]));
    expect(byId.get("SLEEP")!.result.status).toBe("ok");
    expect(byId.get("ADIPOSITY")!.result.status).toBe("ok");
  });
});
