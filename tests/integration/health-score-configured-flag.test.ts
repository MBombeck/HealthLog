/**
 * v1.35.0 — the resolved "this score is configured" flag, over the real
 * wires.
 *
 * The flag is one boolean, and the whole point of resolving it on the
 * server is that no client ever interprets a configuration blob to know
 * it. So the thing worth testing is not the resolver — it has its own
 * unit suite — but the pipe: the selection a person saves through the
 * real write route, read back by the real score reader, carried by the
 * real dashboard-snapshot builder, the real daily-digest builder and the
 * real derived-metric dispatcher, out through the three routes an iOS
 * widget, a watch complication and the web hero actually call.
 *
 * Both ends green with a hand-built object between them shipped an inert
 * fix in this repo once. Nothing here is hand-built: every scenario
 * writes a row, calls the routes, and reads the field off the response
 * body.
 *
 * **The definition under test.** The score is configured when the
 * composition it resolves to differs from the composition the account's
 * defaults would resolve to today, both narrowed by the same modules.
 * Hence the four negatives below, each of which is a way of ending up at
 * the default composition without meaning to say "configured":
 *
 *   - an account that never opened the surface;
 *   - an account that opened it and kept every pillar (it HAS a
 *     selection — `hasSelection` is true — and is still not configured);
 *   - an account whose disabled modules alone narrow the set;
 *   - an account that took out a pillar its modules had already
 *     withdrawn, so the composition is unchanged.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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

// The provider read touches an `app_settings` column that trails the
// production schema in this environment, and no surface under test needs
// a provider: the digest lifts a cached briefing, it never generates one.
vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: vi.fn().mockResolvedValue({ type: "none" }),
  hasAnyConfiguredProvider: vi.fn().mockResolvedValue(false),
  // The AI capability loader's presence probe, answering the same "no
  // provider". Without it the loader throws and every capability on the
  // three wires reads `check_failed` instead of `no_provider`.
  probeProviderChain: vi.fn().mockResolvedValue({
    entries: [],
    localOcrEnabled: false,
    managedBy: null,
  }),
}));

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await resetCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function resetCaches() {
  const { __resetAllCachesForTests } = await import("@/lib/cache/server-cache");
  __resetAllCachesForTests();
}

async function seedSession(username: string, modulePreferences?: unknown) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      heightCm: 178,
      dateOfBirth: new Date("1985-07-09"),
      ...(modulePreferences === undefined
        ? {}
        : { modulePreferencesJson: modulePreferences as object }),
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

/**
 * Three domains' worth of data, which is the floor the composite needs
 * to exist at all: blood pressure (cardiometabolic), sleep, and waist
 * (adiposity). Every scenario seeds the same shape, so the only thing
 * that moves between them is the recipe.
 */
async function seedThreeScorableDomains(userId: string, now: number) {
  const prisma = getPrismaClient();
  for (let i = 0; i < 20; i++) {
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
  for (let i = 0; i < 14; i++) {
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
  await prisma.measurement.create({
    data: {
      userId,
      type: "WAIST_CIRCUMFERENCE",
      value: 82,
      unit: "cm",
      measuredAt: new Date(now),
    },
  });
  // The snapshot's thick phase — the one that carries the health score —
  // stays null until the rollup tier is warm for the dense types. Without
  // the fold this test would read `healthScore: null` on every scenario
  // and prove nothing about the flag.
  const { recomputeUserRollups } =
    await import("@/lib/rollups/measurement-rollups");
  await recomputeUserRollups(userId, { granularities: ["DAY"] });
}

/** Save a selection through the route a person's client actually calls. */
async function saveSelection(pillars: string[]) {
  const { PATCH } = await import("@/app/api/auth/me/health-score-config/route");
  const res = await (PATCH as (req: Request) => Promise<Response>)(
    new Request("http://localhost/api/auth/me/health-score-config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pillars }),
    }),
  );
  expect(res.status).toBe(200);
  await resetCaches();
}

interface Wires {
  snapshot: boolean | undefined;
  digest: boolean | undefined;
  derived: boolean | undefined;
}

/**
 * The three payloads a client reads, each fetched through its own route,
 * each returning the flag it resolved for itself. Nothing is copied
 * between them here — if the snapshot builder forgot to carry the field,
 * or the digest forgot to lift it off the snapshot, this returns
 * `undefined` for that wire and the assertions fail.
 */
async function readWires(): Promise<Wires> {
  await resetCaches();

  const { GET: snapshotGet } =
    await import("@/app/api/dashboard/snapshot/route");
  const snapshotRes = await (
    snapshotGet as (req: Request) => Promise<Response>
  )(new Request("http://localhost/api/dashboard/snapshot"));
  expect(snapshotRes.status).toBe(200);
  const snapshotBody = (await snapshotRes.json()) as {
    data: { healthScore: { configured?: boolean } | null } | null;
  };
  expect(snapshotBody.data?.healthScore ?? null).not.toBeNull();

  const { GET: digestGet } = await import("@/app/api/daily/digest/route");
  const digestRes = await (digestGet as (req: Request) => Promise<Response>)(
    new Request("http://localhost/api/daily/digest"),
  );
  expect(digestRes.status).toBe(200);
  const digestBody = (await digestRes.json()) as {
    data: { score: { configured?: boolean } | null } | null;
  };
  expect(digestBody.data?.score ?? null).not.toBeNull();

  const { GET: derivedGet } = await import("@/app/api/insights/derived/route");
  const derivedRes = await (
    derivedGet as (req: NextRequest) => Promise<Response>
  )(
    new NextRequest(
      "http://localhost/api/insights/derived?metric=HEALTH_SCORE",
    ),
  );
  expect(derivedRes.status).toBe(200);
  const derivedBody = (await derivedRes.json()) as {
    data: {
      status: string;
      value: { configured?: boolean } | null;
      ai: { reason: string | null };
    } | null;
  };
  expect(derivedBody.data?.status).toBe("ok");
  // The AI state rides the same payload. `no_provider` is this fixture's
  // honest answer; `check_failed` would mean a mock starved the capability
  // loader and every wire above was read on its failure path.
  expect(derivedBody.data?.ai.reason).toBe("no_provider");

  return {
    snapshot: snapshotBody.data!.healthScore!.configured,
    digest: digestBody.data!.score!.configured,
    derived: derivedBody.data!.value!.configured,
  };
}

/** Every wire says the same thing, and says it as a boolean. */
function expectEveryWire(wires: Wires, expected: boolean) {
  expect(wires.snapshot).toBe(expected);
  expect(wires.digest).toBe(expected);
  expect(wires.derived).toBe(expected);
}

describe("the resolved configured flag, on every wire that carries it", () => {
  it("reads false for an account that never chose", async () => {
    const user = await seedSession("cfg-never-chose");
    await seedThreeScorableDomains(user.id, Date.now());

    expectEveryWire(await readWires(), false);
  });

  it("reads false for an account that opened the surface and kept every pillar", async () => {
    // The distinction this pins: the resolver's `hasSelection` is TRUE
    // here, because the person wrote something. The wire flag is false,
    // because what they wrote is the default. A client reading
    // `hasSelection` would tell them their score is configured when
    // nothing about it differs from an untouched account's.
    const user = await seedSession("cfg-kept-everything");
    await seedThreeScorableDomains(user.id, Date.now());
    await saveSelection([
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
      "WELLBEING",
      "LIPIDS",
    ]);

    const stored = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { healthScoreConfigJson: true },
    });
    // The write really happened — otherwise this whole case would be
    // testing the never-chose path again under a different name.
    expect(stored.healthScoreConfigJson).toMatchObject({
      excludedPillars: [],
      version: 1,
    });

    expectEveryWire(await readWires(), false);
  });

  it("reads false when disabled modules alone narrow the set", async () => {
    // Glucose, labs and mental health off: GLYCAEMIA, LIPIDS and
    // WELLBEING can carry no data, so five pillars are eligible instead
    // of eight. The person authored nothing, and both sides of the
    // comparison narrow identically.
    const user = await seedSession("cfg-modules-narrow", {
      glucose: false,
      labs: false,
      mentalHealth: false,
    });
    await seedThreeScorableDomains(user.id, Date.now());

    expectEveryWire(await readWires(), false);
  });

  it("reads false when a taken-out pillar is one the modules had already withdrawn", async () => {
    // The recipe is stored and comes back the moment the module does.
    // Today it makes no difference to the composition, so the flag says
    // so rather than claiming an authorship the number does not show.
    const user = await seedSession("cfg-redundant-exclusion", {
      mentalHealth: false,
    });
    await seedThreeScorableDomains(user.id, Date.now());
    await saveSelection([
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
      "LIPIDS",
    ]);

    expectEveryWire(await readWires(), false);
  });

  it("reads true once the person's own recipe narrows the composition", async () => {
    const user = await seedSession("cfg-authored");
    await seedThreeScorableDomains(user.id, Date.now());
    await saveSelection([
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
      "WELLBEING",
    ]);

    const stored = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { healthScoreConfigJson: true },
    });
    expect(stored.healthScoreConfigJson).toMatchObject({
      excludedPillars: ["LIPIDS"],
    });

    expectEveryWire(await readWires(), true);
  });

  it("turns true the moment a recipe is saved and false again when it is undone", async () => {
    // The same account, read three times across two saves. A flag that
    // is computed once and cached under a key that does not include the
    // recipe would pass every case above and fail this one.
    const user = await seedSession("cfg-round-trip");
    await seedThreeScorableDomains(user.id, Date.now());

    expectEveryWire(await readWires(), false);

    // Narrowed: one pillar taken out. If both halves of this case send the
    // same list, the round trip proves nothing — it would read false at both
    // ends and the flip would never be exercised.
    await saveSelection([
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
      "WELLBEING",
    ]);
    expectEveryWire(await readWires(), true);

    await saveSelection([
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
      "WELLBEING",
      "LIPIDS",
    ]);
    expectEveryWire(await readWires(), false);

    const stored = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { healthScoreConfigJson: true },
    });
    expect(stored.healthScoreConfigJson).toMatchObject({ version: 2 });
  });

  it("never puts the configuration itself on any of the three wires", async () => {
    // iOS consumes the resolved flag and nothing else. A per-pillar
    // configuration detail on one of these payloads would invite a
    // client to re-derive the answer, which is the boundary this whole
    // field exists to hold.
    const user = await seedSession("cfg-no-blob");
    await seedThreeScorableDomains(user.id, Date.now());
    await saveSelection([
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
      "WELLBEING",
      "LIPIDS",
    ]);

    const { GET: snapshotGet } =
      await import("@/app/api/dashboard/snapshot/route");
    const snapshotRes = await (
      snapshotGet as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/dashboard/snapshot"));
    const snapshotText = await snapshotRes.text();

    const { GET: digestGet } = await import("@/app/api/daily/digest/route");
    const digestRes = await (digestGet as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/daily/digest"),
    );
    const digestText = await digestRes.text();

    const { GET: derivedGet } =
      await import("@/app/api/insights/derived/route");
    const derivedRes = await (
      derivedGet as (req: NextRequest) => Promise<Response>
    )(
      new NextRequest(
        "http://localhost/api/insights/derived?metric=HEALTH_SCORE",
      ),
    );
    const derivedText = await derivedRes.text();

    for (const body of [snapshotText, digestText, derivedText]) {
      expect(body).toContain('"configured"');
      expect(body).not.toContain("excludedPillars");
      expect(body).not.toContain("hasSelection");
      expect(body).not.toContain("healthScoreConfig");
    }
  });
});
