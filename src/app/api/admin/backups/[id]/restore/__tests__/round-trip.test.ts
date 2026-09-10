/**
 * Export → wire schema → restore, driven end to end.
 *
 * Every other test around the backup proves ONE end. `full-backup-payload.test.ts`
 * proves the builder emits a key; the restore tests prove the route refuses a
 * bad file. Between them sits the gap that lost three domains in a row: a key
 * the builder emits, the schema drops or nobody reads, and the restore reports
 * success over.
 *
 * So this test does not assert on the payload. It builds a real payload from a
 * populated account, serialises it, parses it back through the REAL
 * `parseBackupPayload`, hands it to the REAL route, and asserts on the rows the
 * restore tried to write. A field that survives that survives a restore.
 *
 * The transaction stand-in is deliberately not inert: `cycleSymptom.findMany`
 * answers from what the restore actually upserted. If the account's own symptom
 * definitions do not ride the file, the link resolution finds nothing and the
 * restore throws — which is what a real instance does, and is exactly how the
 * inert v1.33.1 fix behaved in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Buffer } from "node:buffer";

import { SCORE_VERSION } from "@/lib/analytics/score/types";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  requireAdmin: vi.fn(async () => ({ user: { id: "admin-1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    dataBackup: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: mocks.transaction,
  },
  toJson: <T>(value: T) => value,
}));

// Only `decrypt` is stubbed — it stands in for reading the stored backup blob.
// The rest of the module stays real, so the ciphertext this test builds and the
// ciphertext the restore writes are produced by the same code an instance runs.
vi.mock("@/lib/crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crypto")>()),
  decrypt: mocks.decrypt,
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency: (fn: unknown) => fn,
  defaultUserIdResolver: vi.fn(),
}));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateUserData: vi.fn() }));
vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeUserMoodRollups: vi.fn(),
}));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeUserMedicationCompliance: vi.fn(),
  MEDICATION_COMPLIANCE_BACKFILL_DAYS: 30,
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeUserRollups: vi.fn(),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";

const OWNER = "user-A";

/**
 * A day's cumulative curve, twenty-four running totals. Uneven on purpose: a
 * flat ramp would survive a restore that rebuilt the shape from `dayTotal`
 * instead of carrying it, and this file is the only copy of the real one.
 */
const DAY_CURVE = [
  0, 0, 0, 0, 0, 0, 120, 940, 2310, 2380, 2400, 2860, 4120, 4180, 4200, 4260,
  5010, 6340, 7480, 8020, 8090, 8110, 8110, 8110,
];

/* ── the account being backed up ────────────────────────────────────── */

function sourceClient() {
  const empty = { findMany: vi.fn().mockResolvedValue([]) };
  return {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    measurement: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    medication: { findMany: vi.fn().mockResolvedValue([]) },
    medicationIntakeEvent: empty,
    moodEntry: empty,
    moodTag: empty,
    nutrientIntakeDay: empty,
    // Cycle: one day-log whose symptom is one the ACCOUNT defined, which is
    // the case the payload assembly used to drop.
    cycleProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    menstrualCycle: { findMany: vi.fn().mockResolvedValue([]) },
    cycleDayLog: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "day-1",
          date: "2026-07-19",
          cycleId: null,
          flow: null,
          intermenstrualBleeding: false,
          basalBodyTempC: null,
          temperatureExcluded: false,
          ovulationTest: null,
          cervicalMucus: null,
          cervixPosition: null,
          cervixFirmness: null,
          cervixOpening: null,
          sexualActivity: false,
          protectedSex: null,
          pregnancyTest: null,
          progesteroneTest: null,
          contraceptive: null,
          sensitiveEncrypted: null,
          notesEncrypted: null,
          source: "MANUAL",
          externalId: null,
          tz: null,
          syncVersion: 0,
          deletedAt: null,
          createdAt: new Date("2026-07-19T00:00:00.000Z"),
          updatedAt: new Date("2026-07-19T00:00:00.000Z"),
          symptomLinks: [{ symptom: { key: "custom:jaw_tension" } }],
        },
      ]),
    },
    cycleSymptom: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "sym-1",
          key: "custom:jaw_tension",
          labelKey: "custom",
          categoryId: "cat-1",
          icon: null,
          sortOrder: 0,
          isActive: true,
          labelEncrypted: "envelope",
        },
      ]),
    },
    // Records section: empty, exercised by its own suite.
    labResult: empty,
    biomarker: empty,
    illnessEpisode: empty,
    allergy: empty,
    familyHistoryEntry: empty,
    workout: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "workout-fitbit-1",
          userId: OWNER,
          sportType: "other",
          startedAt: new Date("2026-07-18T08:00:00.000Z"),
          endedAt: new Date("2026-07-18T08:30:00.000Z"),
          durationSec: 1800,
          totalEnergyKcal: 180,
          totalDistanceM: null,
          avgHeartRate: 125,
          maxHeartRate: null,
          minHeartRate: null,
          stepCount: null,
          elevationM: null,
          pauseDurationSec: null,
          source: "FITBIT",
          externalId: "91002",
          metadata: {
            fitbitActivityName: "Activity Zeta",
            fitbitActivityTypeId: 9002,
          },
          createdAt: new Date("2026-07-18T08:30:00.000Z"),
          updatedAt: new Date("2026-07-18T08:30:00.000Z"),
        },
      ]),
    },
    inboundDocument: empty,
    // The two domains this stream adds.
    userHealthProfile: {
      findUnique: vi.fn().mockResolvedValue({
        id: "profile-1",
        userId: OWNER,
        aboutMeEncrypted: encryptToBytes("desk job, two kids"),
        conditionsEncrypted: null,
        allergiesEncrypted: encryptToBytes("penicillin"),
        coachFocusEncrypted: null,
        pendingQuestionsEncrypted: encryptToBytes('["How is your sleep?"]'),
        aiIncludedSections: ["CONDITIONS", "SMOKING_STATUS"],
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-19T00:00:00.000Z"),
      }),
    },
    healthProfileFactRevision: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "fact-old",
          userId: OWNER,
          kind: "SMOKING_STATUS",
          valueEncrypted: encryptToBytes("CURRENT"),
          validFrom: new Date("2026-07-01T00:00:00.000Z"),
          validUntil: new Date("2026-07-10T00:00:00.000Z"),
          provenance: "USER_REPORTED",
          supersededByRevisionId: "fact-current",
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          id: "fact-current",
          userId: OWNER,
          kind: "SMOKING_STATUS",
          valueEncrypted: encryptToBytes("FORMER"),
          validFrom: new Date("2026-07-10T00:00:00.000Z"),
          validUntil: null,
          provenance: "USER_CORRECTION",
          supersededByRevisionId: null,
          createdAt: new Date("2026-07-10T00:00:00.000Z"),
        },
      ]),
    },
    // The hourly shape of a drained day. The per-sample rows it was folded
    // from are already gone, so nothing but this row can rebuild it.
    intradayCumulativeProfile: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "shape-1",
          userId: OWNER,
          type: "ACTIVITY_STEPS",
          dateKey: "2026-07-18",
          hourlyCumulative: DAY_CURVE,
          dayTotal: DAY_CURVE[23],
          sampleCount: 96,
          timezone: "Europe/Berlin",
          createdAt: new Date("2026-07-19T02:00:00.000Z"),
          updatedAt: new Date("2026-07-19T02:00:00.000Z"),
        },
      ]),
    },
    // The setup answers. Absent for this fixture's account, which is the
    // ordinary case: the export has to answer for a record that never entered
    // the flow without inventing one.
    onboardingRecord: { findUnique: vi.fn().mockResolvedValue(null) },
    // The score as it was SHOWN on a local day. Not recomputable: today's
    // number always comes from today's rows, so once the readings behind this
    // day moved, nothing can reproduce what it said.
    healthScoreRecord: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "score-day-1",
          userId: OWNER,
          dayKey: "2026-07-18",
          timezone: "Europe/Berlin",
          composite: 76,
          band: "yellow",
          scoreVersion: SCORE_VERSION,
          composition: ["BLOOD_PRESSURE", "SLEEP", "ADIPOSITY"],
          pillarScores: { BLOOD_PRESSURE: 86, SLEEP: 100, ADIPOSITY: 42 },
          inputFingerprint: "a".repeat(64),
          configVersion: null,
          configChangedAt: null,
          computedAt: new Date("2026-07-18T20:00:00.000Z"),
          createdAt: new Date("2026-07-18T20:00:00.000Z"),
        },
      ]),
    },
    // The visit tables. Empty here: this file asserts the sections it seeds,
    // and an account with no visits is the ordinary case the builder must
    // still answer for.
    practitioner: { findMany: vi.fn().mockResolvedValue([]) },
    encounter: { findMany: vi.fn().mockResolvedValue([]) },
    encounterDocumentLink: { findMany: vi.fn().mockResolvedValue([]) },
    encounterLabLink: { findMany: vi.fn().mockResolvedValue([]) },
    encounterConditionLink: { findMany: vi.fn().mockResolvedValue([]) },
    vaccinationRecord: { findMany: vi.fn().mockResolvedValue([]) },
    vaccinationDocumentLink: { findMany: vi.fn().mockResolvedValue([]) },
    // The reminder engine tables (v1.37.20, #223 / iOS #68). Empty for the
    // same reason as the visit tables above.
    measurementReminder: { findMany: vi.fn().mockResolvedValue([]) },
    measurementReminderEvent: { findMany: vi.fn().mockResolvedValue([]) },
    // The bests, the badges, and the environmental history with the location
    // periods that explain it. Empty for the same reason as the tables above.
    personalRecord: { findMany: vi.fn().mockResolvedValue([]) },
    userAchievement: { findMany: vi.fn().mockResolvedValue([]) },
    environmentContext: { findMany: vi.fn().mockResolvedValue([]) },
    environmentTravelLocation: { findMany: vi.fn().mockResolvedValue([]) },
    coachConversation: { findMany: vi.fn().mockResolvedValue([]) },
    moodTagCategory: { findMany: vi.fn().mockResolvedValue([]) },
    moodTagHidden: { findMany: vi.fn().mockResolvedValue([]) },
    mentalHealthAssessment: { findMany: vi.fn().mockResolvedValue([]) },
    consentReceipt: { findMany: vi.fn().mockResolvedValue([]) },
    coachFact: { findMany: vi.fn().mockResolvedValue([]) },
    coachPlan: { findMany: vi.fn().mockResolvedValue([]) },
    coachReminder: { findMany: vi.fn().mockResolvedValue([]) },
    // What a document was filed against, and what was read out of it.
    // Empty for the same reason as the sections above.
    documentConditionLink: { findMany: vi.fn().mockResolvedValue([]) },
    extractedFact: { findMany: vi.fn().mockResolvedValue([]) },
    ecgRecording: { findMany: vi.fn().mockResolvedValue([]) },
    customMetric: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "metric-1",
          userId: OWNER,
          name: "Morning grip strength",
          unit: "kg",
          targetLow: 40,
          targetHigh: null,
          decimals: 1,
          description: "Right hand, before breakfast",
          correlationEnabled: true,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-19T00:00:00.000Z"),
          deletedAt: null,
          entries: [
            {
              id: "entry-1",
              value: 44.5,
              unit: "kg",
              measuredAt: new Date("2026-07-19T06:30:00.000Z"),
              note: "felt strong",
              createdAt: new Date("2026-07-19T06:31:00.000Z"),
            },
          ],
        },
      ]),
    },
    correlationPattern: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "pattern-1",
          userId: OWNER,
          canonicalKey: `p1:${"a".repeat(64)}`,
          family: "DISCOVERY_RETROSPECTIVE",
          factorKey: "CUSTOM_METRIC:metric-1",
          outcomeKey: "RESTING_HEART_RATE",
          lagDays: 1,
          sampleSize: 42,
          effectSize: 0.34,
          pValue: 0.01,
          qValue: 0.04,
          evidenceHash: "b".repeat(64),
          isCurrent: true,
          lastComputedAt: new Date("2026-07-19T08:00:00.000Z"),
          dismissedAt: new Date("2026-07-19T09:00:00.000Z"),
          dismissedEvidenceHash: "b".repeat(64),
          dismissedEffectSize: 0.34,
          dismissedSampleSize: 42,
          createdAt: new Date("2026-07-19T08:00:00.000Z"),
          updatedAt: new Date("2026-07-19T09:00:00.000Z"),
        },
      ]),
    },
  };
}

/* ── the instance being restored into ───────────────────────────────── */

interface Written {
  model: string;
  op: string;
  data: Record<string, unknown>;
}

/**
 * `seed` lets a test answer `findUnique`/`findMany` reads with the live
 * pre-restore state (the row set the restore's cache-invalidation check
 * reads before it deletes and rebuilds), keyed by model name. Every other
 * test leaves it empty, which reproduces the old "nothing lives here yet"
 * behaviour exactly.
 */
function recordingTx(
  written: Written[],
  seed: Record<string, { findUnique?: unknown; findMany?: unknown[] }> = {},
) {
  // Symptom definitions the restore has written back, so link resolution can
  // only succeed if the definitions actually rode the file.
  const restoredSymptoms = new Map<string, string>();

  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get(_t, op: string) {
          return async (args: Record<string, unknown> = {}) => {
            if (op === "deleteMany") return { count: 0 };
            if (op === "findMany") {
              if (model === "cycleSymptom") {
                return [...restoredSymptoms].map(([key, id]) => ({ id, key }));
              }
              return seed[model]?.findMany ?? [];
            }
            if (op === "findFirst" || op === "findUnique") {
              return seed[model]?.findUnique ?? null;
            }
            const data = (args.data ?? args.create ?? {}) as Record<
              string,
              unknown
            >;
            if (
              op === "create" ||
              op === "upsert" ||
              op === "createMany" ||
              op === "update"
            ) {
              if (model === "cycleSymptom" && typeof data.key === "string") {
                restoredSymptoms.set(data.key, (data.id as string) ?? "new-id");
              }
              written.push({ model, op, data });
            }
            return { id: (data.id as string) ?? `${model}-created` };
          };
        },
      },
    );

  return new Proxy({} as Record<string, unknown>, {
    get: (_t, model: string) => delegate(model),
  });
}

function request(): NextRequest {
  return new NextRequest("http://localhost/api/admin/backups/b-1/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

/**
 * Build a real backup for the account above, then restore it.
 *
 * `payloadOverride` lets a test build the payload once, derive a "live"
 * seed from its exact bytes, and restore that SAME payload — rebuilding it
 * would re-encrypt every ciphertext field with a fresh random IV, making an
 * unchanged-scope restore look changed for reasons that have nothing to do
 * with scope.
 */
async function roundTrip(
  seed: Record<string, { findUnique?: unknown; findMany?: unknown[] }> = {},
  payloadOverride?: Record<string, unknown>,
): Promise<{
  res: Response;
  written: Written[];
  payload: Record<string, unknown>;
}> {
  const payload =
    payloadOverride ??
    (
      await buildFullBackupPayload(sourceClient() as never, OWNER, {
        purpose: "disaster-recovery",
      })
    ).payload;

  // The file as it lands on disk: JSON, nothing else.
  mocks.decrypt.mockReturnValue(JSON.stringify(payload));

  const written: Written[] = [];
  mocks.transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(recordingTx(written, seed)),
  );

  const res = await (
    POST as unknown as (r: NextRequest, c: unknown) => Promise<Response>
  )(request(), { params: Promise.resolve({ id: "b-1" }) });

  return { res, written, payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.dataBackup.findUnique).mockResolvedValue({
    id: "b-1",
    userId: OWNER,
    data: "cipher",
    user: { id: OWNER, username: "owner" },
  } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: OWNER,
    username: "owner",
    timezone: "UTC",
  } as never);
});

describe("backup round trip — export, wire schema, restore", () => {
  it("completes without the restore reporting a failure", async () => {
    const { res } = await roundTrip();
    expect(res.status).toBe(200);
  });

  it("writes the durable self-context back with its ciphertext intact", async () => {
    const { written } = await roundTrip();

    const profile = written.find((w) => w.model === "userHealthProfile");
    expect(
      profile,
      "the profile reached the file and nothing wrote it back",
    ).toBeDefined();
    expect(profile!.data.userId).toBe(OWNER);
    // The envelope round-trips as bytes, not as a re-encryption of plaintext
    // the DR file never carried.
    expect(profile!.data.aboutMeEncrypted).toBeInstanceOf(Uint8Array);
    expect(profile!.data.conditionsEncrypted).toBeNull();
    expect(profile!.data.pendingQuestionsEncrypted).toBeInstanceOf(Uint8Array);
    expect(profile!.data.aiIncludedSections).toEqual([
      "CONDITIONS",
      "SMOKING_STATUS",
    ]);
  });

  it("writes every encrypted fact revision back", async () => {
    const { written } = await roundTrip();
    const facts = written.filter(
      (write) =>
        write.model === "healthProfileFactRevision" && write.op === "create",
    );
    expect(facts).toHaveLength(2);
    expect(facts.map((write) => write.data.id)).toEqual([
      "fact-old",
      "fact-current",
    ]);
    expect(facts[0].data.valueEncrypted).toBeInstanceOf(Uint8Array);
    expect(facts[1].data.valueEncrypted).toBeInstanceOf(Uint8Array);
    expect(facts[0].data.validUntil).toEqual(
      new Date("2026-07-10T00:00:00.000Z"),
    );
    expect(facts[1].data.validUntil).toBeNull();
  });

  it("writes each custom metric back with its readings", async () => {
    const { written } = await roundTrip();

    const metric = written.find((w) => w.model === "customMetric");
    expect(
      metric,
      "the metric reached the file and nothing wrote it back",
    ).toBeDefined();
    expect(metric!.data).toMatchObject({
      userId: OWNER,
      name: "Morning grip strength",
      unit: "kg",
      targetLow: 40,
      decimals: 1,
      description: "Right hand, before breakfast",
      correlationEnabled: true,
    });

    // The readings are the half that would go missing quietly: a metric with
    // no entries renders as an empty chart rather than as an error.
    const entries = (
      metric!.data.entries as { create: Array<Record<string, unknown>> }
    ).create;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      value: 44.5,
      unit: "kg",
      note: "felt strong",
    });
  });

  it("writes persisted pattern identity and dismissal evidence back", async () => {
    const { written } = await roundTrip();
    const pattern = written.find((w) => w.model === "correlationPattern");
    expect(pattern).toBeDefined();
    expect(pattern!.data).toMatchObject({
      userId: OWNER,
      canonicalKey: `p1:${"a".repeat(64)}`,
      family: "DISCOVERY_RETROSPECTIVE",
      factorKey: "CUSTOM_METRIC:metric-1",
      outcomeKey: "RESTING_HEART_RATE",
      dismissedEvidenceHash: "b".repeat(64),
      dismissedEffectSize: 0.34,
      dismissedSampleSize: 42,
    });
    expect(pattern!.data.dismissedAt).toEqual(
      new Date("2026-07-19T09:00:00.000Z"),
    );
  });

  it("writes unknown Fitbit workout provenance back with the workout", async () => {
    const { written } = await roundTrip();
    const write = written.find(
      (entry) => entry.model === "workout" && entry.op === "createMany",
    );
    const rows = write!.data as unknown as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "FITBIT",
      sportType: "other",
      externalId: "91002",
      metadata: {
        fitbitActivityName: "Activity Zeta",
        fitbitActivityTypeId: 9002,
      },
    });
  });

  it("writes the day's cumulative shape back, every hour of it", async () => {
    const { written } = await roundTrip();

    const write = written.find(
      (w) => w.model === "intradayCumulativeProfile" && w.op === "createMany",
    );
    expect(
      write,
      "the day curve reached the file and nothing wrote it back",
    ).toBeDefined();

    const rows = write!.data as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "shape-1",
      userId: OWNER,
      type: "ACTIVITY_STEPS",
      dateKey: "2026-07-18",
      dayTotal: DAY_CURVE[23],
      sampleCount: 96,
      // Dropping the zone would make a curve cut on another clock look
      // comparable to one cut on this account's.
      timezone: "Europe/Berlin",
    });
    // The curve is the part that cannot be rebuilt from anything else, so it
    // is asserted hour by hour rather than by its total.
    expect(rows[0].hourlyCumulative).toEqual(DAY_CURVE);
  });

  it("writes the recorded score day back with the number it showed", async () => {
    const { written } = await roundTrip();

    const write = written.find(
      (w) => w.model === "healthScoreRecord" && w.op === "createMany",
    );
    expect(
      write,
      "the recorded score day reached the file and nothing wrote it back",
    ).toBeDefined();

    const rows = write!.data as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "score-day-1",
      userId: OWNER,
      dayKey: "2026-07-18",
      timezone: "Europe/Berlin",
      composite: 76,
      band: "yellow",
      scoreVersion: SCORE_VERSION,
      inputFingerprint: "a".repeat(64),
    });
    // The composition and the per-pillar scores are what keep the stored day
    // readable across a later change to what counts. A row that came back
    // with only its headline would look restored and answer nothing.
    expect(rows[0].composition).toEqual([
      "BLOOD_PRESSURE",
      "SLEEP",
      "ADIPOSITY",
    ]);
    expect(rows[0].pillarScores).toEqual({
      BLOOD_PRESSURE: 86,
      SLEEP: 100,
      ADIPOSITY: 42,
    });
  });

  it("writes the account's own cycle symptom back before resolving its links", async () => {
    const { written, res } = await roundTrip();

    // The definition has to land, or the link lookup below finds nothing.
    expect(
      written.find(
        (w) =>
          w.model === "cycleSymptom" && w.data.key === "custom:jaw_tension",
      ),
      "the custom symptom definition never reached the restore",
    ).toBeDefined();

    // And the day-log that references it restores rather than throwing on an
    // unresolvable key — the failure a real account hit while the fix was inert.
    expect(res.status).toBe(200);
    expect(written.find((w) => w.model === "cycleDayLog")).toBeDefined();
  });

  describe("cached briefing invalidation on AI-scope change", () => {
    // The source account's backup carries `aiIncludedSections: ["CONDITIONS",
    // "SMOKING_STATUS"]` and the two SMOKING_STATUS fact revisions from
    // `sourceClient()`. Reused below to build a byte-identical "live" seed so
    // the unchanged-scope case is a genuine no-op, not a coincidence of two
    // separately encrypted ciphertexts happening to differ.
    function liveFactRowsFromPayload(payload: Record<string, unknown>) {
      const facts = payload.healthProfileFacts as Array<{
        id: string;
        kind: string;
        valueEncrypted: string;
        validFrom: string;
        validUntil: string | null;
        provenance: string;
        supersededByRevisionId: string | null;
      }>;
      return facts.map((fact) => ({
        id: fact.id,
        userId: OWNER,
        kind: fact.kind,
        valueEncrypted: Buffer.from(fact.valueEncrypted, "base64"),
        validFrom: new Date(fact.validFrom),
        validUntil: fact.validUntil ? new Date(fact.validUntil) : null,
        provenance: fact.provenance,
        supersededByRevisionId: fact.supersededByRevisionId,
      }));
    }

    it("clears the cached briefing when the restored scope narrows", async () => {
      // Live account currently has every section included — strictly wider
      // than the backup's ["CONDITIONS", "SMOKING_STATUS"], so the restore
      // narrows scope and must invalidate the pre-restore cache.
      const { written } = await roundTrip({
        userHealthProfile: {
          findUnique: {
            aiIncludedSections: [
              "ABOUT_ME",
              "CONDITIONS",
              "ALLERGIES",
              "COACH_FOCUS",
              "FAMILY_HISTORY",
              "SMOKING_STATUS",
              "ALCOHOL_PATTERN",
              "SHIFT_SCHEDULE",
            ],
          },
        },
      });

      const userUpdate = written.find(
        (w) => w.model === "user" && w.op === "update",
      );
      expect(
        userUpdate,
        "a scope-narrowing restore must clear the cached briefing",
      ).toBeDefined();
      // The language tag is cleared with the text: an empty slot carries
      // no language, and the next write tags it afresh.
      expect(userUpdate!.data).toEqual({
        insightsCachedText: null,
        insightsCachedAt: null,
        insightsCachedLocale: null,
      });
    });

    it("leaves the cached briefing alone when the restored scope is unchanged", async () => {
      const { payload } = await buildFullBackupPayload(
        sourceClient() as never,
        OWNER,
        { purpose: "disaster-recovery" },
      );
      const liveSeed = {
        userHealthProfile: {
          findUnique: {
            aiIncludedSections: (
              payload.healthProfile as { aiIncludedSections: string[] }
            ).aiIncludedSections,
          },
        },
        healthProfileFactRevision: {
          findMany: liveFactRowsFromPayload(payload),
        },
      };

      // Restore that SAME payload — rebuilding it would re-encrypt every
      // ciphertext field with a fresh IV, so the only variable this way is
      // whether the restore over-invalidates on a genuine no-op.
      const { written: writtenUnchanged } = await roundTrip(liveSeed, payload);

      const userUpdate = writtenUnchanged.find(
        (w) => w.model === "user" && w.op === "update",
      );
      expect(
        userUpdate,
        "an unchanged AI scope must not clear the cached briefing",
      ).toBeUndefined();
    });
  });
});
