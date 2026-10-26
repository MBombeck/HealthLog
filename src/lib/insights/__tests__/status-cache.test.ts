import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    insightStatusCache: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    // v1.18.11 — the input gate / fingerprint probe salient inputs.
    measurement: { groupBy: vi.fn() },
    moodEntry: { aggregate: vi.fn() },
    customMetric: { findMany: vi.fn() },
  },
}));

// A reversible stand-in for the at-rest codec: the store's own logic (what it
// serves, what it re-dates, what it leaves alone) is what these tests pin, not
// AES-GCM.
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (plain: string) => new TextEncoder().encode(`enc:${plain}`),
  decryptFromBytes: (buf: Uint8Array) => {
    const text = new TextDecoder().decode(buf);
    if (!text.startsWith("enc:")) throw new Error("unknown key id");
    return text.slice(4);
  },
}));

const aiCapabilityForRecord = vi.fn();
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: (...a: unknown[]) => aiCapabilityForRecord(...a),
  aiCapabilityToServe: (...args: unknown[]) =>
    (aiCapabilityForRecord as (...a: unknown[]) => unknown)(...args),
}));

const probeProviderPresence = vi.fn();
vi.mock("@/lib/ai/provider", () => ({
  probeProviderPresence: (...a: unknown[]) => probeProviderPresence(...a),
}));

const enqueueStatusGeneration = vi.fn();
vi.mock("@/lib/jobs/insight-status-generate-shared", () => ({
  enqueueStatusGeneration: (...a: unknown[]) => enqueueStatusGeneration(...a),
}));

import { prisma } from "@/lib/db";
import {
  computeStatusInputFingerprint,
  gateUnchangedStatusInput,
  readFreshStatusText,
  readLastGoodStatusText,
  readStatusNegativeCache,
  refreshUnchangedStatusInsight,
  resolveReadOnlyStatusMiss,
  writeStatusNote,
} from "../status-cache";

const TODAY = "2026-05-31";
const AVAILABLE = { available: true, reason: null, onDeviceAllowed: true };

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(`enc:${text}`);
}

/** One `InsightStatusCache` row as `findUnique` would return it. */
function noteRow(fields: {
  text?: string | null;
  dateKey?: string;
  generatedAt?: Date | null;
  snapshotHash?: string | null;
  inputHash?: string | null;
  retryAt?: Date | null;
  negativeReason?: string | null;
  textEncrypted?: Uint8Array | null;
}) {
  return {
    textEncrypted:
      fields.textEncrypted !== undefined
        ? fields.textEncrypted
        : fields.text == null
          ? null
          : enc(fields.text),
    itemsEncrypted: null,
    inputHash: fields.inputHash ?? null,
    snapshotHash: fields.snapshotHash ?? null,
    dateKey: fields.dateKey ?? TODAY,
    generatedAt:
      fields.generatedAt !== undefined ? fields.generatedAt : new Date(),
    retryAt: fields.retryAt ?? null,
    negativeReason: fields.negativeReason ?? null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.customMetric.findMany).mockResolvedValue([] as never);
  aiCapabilityForRecord.mockResolvedValue(AVAILABLE);
  probeProviderPresence.mockResolvedValue(true);
});

describe("writeStatusNote", () => {
  it("upserts one encrypted row per (user, metric, locale) and clears the negative window", async () => {
    vi.mocked(prisma.insightStatusCache.upsert).mockResolvedValue({} as never);
    await writeStatusNote({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      text: "Stable.",
      snapshotHash: "s".repeat(64),
    });
    const arg = vi.mocked(prisma.insightStatusCache.upsert).mock
      .calls[0][0] as {
      where: { userId_metric_locale: Record<string, string> };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.where.userId_metric_locale).toEqual({
      userId: "u1",
      metric: "weight",
      locale: "en",
    });
    expect(
      new TextDecoder().decode(arg.update.textEncrypted as Uint8Array),
    ).toBe("enc:Stable.");
    expect(arg.update.dateKey).toBe(TODAY);
    expect(arg.update.snapshotHash).toBe("s".repeat(64));
    expect(arg.update.retryAt).toBeNull();
    expect(arg.update.negativeReason).toBeNull();
    // #1279 — a note ends the run of failures that sized its window.
    expect(arg.update.failureStreak).toBe(0);
  });
});

describe("readFreshStatusText", () => {
  it("returns today's real assessment text", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({ text: "Your weight trend is stable." }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit?.text).toBe("Your weight trend is stable.");
    expect(prisma.insightStatusCache.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_metric_locale: {
            userId: "u1",
            metric: "weight",
            locale: "en",
          },
        },
      }),
    );
  });

  it("serves today's note even while a negative window is open on it", async () => {
    // A stall writes the window next to the note; it never shadows the text.
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        text: "Real assessment.",
        retryAt: new Date(Date.now() + 60_000),
        negativeReason: "timeout",
      }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit?.text).toBe("Real assessment.");
  });

  it("misses on a row that carries only a negative window", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        text: null,
        generatedAt: null,
        retryAt: new Date(Date.now() + 60_000),
        negativeReason: "timeout",
      }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });

  it("skips a stale-day row", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({ dateKey: "2026-05-30", text: "Yesterday." }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });

  it("skips an empty-text row", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({ text: "   " }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });

  it("does not read the cache under force", async () => {
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: true,
    });
    expect(hit).toBeNull();
    expect(prisma.insightStatusCache.findUnique).not.toHaveBeenCalled();
  });

  it("treats a note it cannot decrypt as a miss", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        textEncrypted: new TextEncoder().encode("{not ciphertext"),
      }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
  });

  it("returns null when statusText is unavailable, without reading the row", async () => {
    aiCapabilityForRecord.mockResolvedValue({
      available: false,
      reason: "user_disabled",
      onDeviceAllowed: false,
    });
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({ text: "Would have been served." }) as never,
    );
    const hit = await readFreshStatusText({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      force: false,
    });
    expect(hit).toBeNull();
    expect(aiCapabilityForRecord).toHaveBeenCalledWith("u1", "statusText");
    expect(prisma.insightStatusCache.findUnique).not.toHaveBeenCalled();
  });
});

describe("readLastGoodStatusText", () => {
  it("serves a note from an earlier day", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        dateKey: "2026-05-29",
        text: "Two days old.",
        generatedAt: new Date("2026-05-29T04:30:00.000Z"),
      }) as never,
    );
    expect(
      await readLastGoodStatusText({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
      }),
    ).toEqual({
      text: "Two days old.",
      updatedAt: "2026-05-29T04:30:00.000Z",
    });
  });

  it("serves nothing when statusText is unavailable", async () => {
    aiCapabilityForRecord.mockResolvedValue({
      available: false,
      reason: "consent_required",
      onDeviceAllowed: false,
    });
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({ text: "Old text." }) as never,
    );
    expect(
      await readLastGoodStatusText({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
      }),
    ).toBeNull();
  });
});

describe("readStatusNegativeCache", () => {
  it("reports an open window and flips retryable once retryAt passes", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValueOnce(
      noteRow({
        text: "Kept.",
        retryAt: new Date(Date.now() + 60_000),
        negativeReason: "screened",
      }) as never,
    );
    const open = await readStatusNegativeCache({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
    });
    expect(open).toMatchObject({ reason: "screened", retryable: false });

    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValueOnce(
      noteRow({
        text: "Kept.",
        retryAt: new Date(Date.now() - 60_000),
        negativeReason: "timeout",
      }) as never,
    );
    const closed = await readStatusNegativeCache({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
    });
    expect(closed).toMatchObject({ reason: "timeout", retryable: true });
  });
});

describe("resolveReadOnlyStatusMiss", () => {
  beforeEach(() => {
    // Default: no row at all — no last-good text, no negative window.
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      null as never,
    );
  });

  it("returns unavailable with hasProvider from the probe and enqueues nothing", async () => {
    aiCapabilityForRecord.mockResolvedValue({
      available: false,
      reason: "consent_required",
      onDeviceAllowed: false,
    });
    probeProviderPresence.mockResolvedValue(true);
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "weight",
      locale: "en",
    });
    // A withdrawn consent is not "no provider": the probe says one exists.
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "consent_required",
      hasProvider: true,
    });
    expect(probeProviderPresence).toHaveBeenCalledWith("u1", "text");
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
    expect(prisma.insightStatusCache.findUnique).not.toHaveBeenCalled();
  });

  it("returns unavailable/no_provider without enqueuing when the user has no provider", async () => {
    aiCapabilityForRecord.mockResolvedValue({
      available: false,
      reason: "no_provider",
      onDeviceAllowed: false,
    });
    probeProviderPresence.mockResolvedValue(false);
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "weight",
      locale: "en",
    });
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "no_provider",
      hasProvider: false,
    });
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
  });

  it("enqueues generation and returns preparing on a clean miss", async () => {
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "pulse",
      locale: "de",
    });
    // No last-good text to show, so nothing to revalidate against — the card
    // polls on `preparing` alone.
    expect(outcome).toEqual({
      kind: "preparing",
      lastGood: null,
      revalidating: false,
    });
    expect(enqueueStatusGeneration).toHaveBeenCalledWith({
      userId: "u1",
      metric: "pulse",
      locale: "de",
    });
  });

  it("serves the last good assessment stale-while-revalidate on a clean miss", async () => {
    // A prior (e.g. yesterday's) real assessment is on record.
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        dateKey: "2026-05-30",
        text: "Steady upward trend.",
        generatedAt: new Date("2026-05-30T04:30:00.000Z"),
      }) as never,
    );
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "weight",
      locale: "en",
    });
    expect(outcome.kind).toBe("preparing");
    if (outcome.kind !== "preparing") throw new Error("expected preparing");
    expect(outcome.lastGood?.text).toBe("Steady upward trend.");
    // v1.9.0 — stale text served AND a refresh enqueued → revalidating so the
    // open card keeps polling until the fresh assessment lands.
    expect(outcome.revalidating).toBe(true);
    // A refresh is still enqueued behind the stale serve.
    expect(enqueueStatusGeneration).toHaveBeenCalledTimes(1);
  });

  it("suppresses re-enqueue while a negative window is open, still serving the last note", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        dateKey: "2026-05-30",
        text: "Yesterday's note.",
        retryAt: new Date(Date.now() + 60_000),
        negativeReason: "timeout",
      }) as never,
    );
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "mood",
      locale: "en",
    });
    expect(outcome.kind).toBe("preparing");
    if (outcome.kind !== "preparing") throw new Error("expected preparing");
    // The window does not hide the stored note.
    expect(outcome.lastGood?.text).toBe("Yesterday's note.");
    // No enqueue on the suppressed branch → nothing in flight to revalidate.
    expect(outcome.revalidating).toBe(false);
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
  });

  it("re-enqueues once the negative window's retryAt has passed", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        text: null,
        generatedAt: null,
        retryAt: new Date(Date.now() - 60_000),
        negativeReason: "timeout",
      }) as never,
    );
    const outcome = await resolveReadOnlyStatusMiss({
      userId: "u1",
      metric: "bmi",
      locale: "de",
    });
    expect(outcome.kind).toBe("preparing");
    expect(enqueueStatusGeneration).toHaveBeenCalledTimes(1);
  });
});

describe("refreshUnchangedStatusInsight (v1.16.8)", () => {
  const HASH = "a".repeat(64);

  it("misses (and writes nothing) when statusText is unavailable, even on a hash match", async () => {
    aiCapabilityForRecord.mockResolvedValue({
      available: false,
      reason: "consent_required",
      onDeviceAllowed: false,
    });
    const hit = await refreshUnchangedStatusInsight({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      snapshotHash: HASH,
    });
    expect(hit).toBeNull();
    // The gate must not even read the row — an unavailable capability can
    // never re-date old AI text as today's assessment.
    expect(prisma.insightStatusCache.findUnique).not.toHaveBeenCalled();
    expect(prisma.insightStatusCache.updateMany).not.toHaveBeenCalled();
    expect(aiCapabilityForRecord).toHaveBeenCalledWith("u1", "statusText");
  });

  it("re-dates the row under today's dateKey and returns the text on a hash match", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        dateKey: "2026-05-30",
        text: "Stable weight, no concerns.",
        snapshotHash: HASH,
      }) as never,
    );
    vi.mocked(prisma.insightStatusCache.updateMany).mockResolvedValue(
      {} as never,
    );

    const hit = await refreshUnchangedStatusInsight({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      snapshotHash: HASH,
    });

    expect(hit?.text).toBe("Stable weight, no concerns.");
    expect(hit?.expiresAfterDateKey).toBe(TODAY);
    // The re-date moves only the day key and timestamp: the note and its
    // fingerprints stay, so the read path and the ingest debounce both see a
    // current assessment and tomorrow's gate still matches.
    expect(prisma.insightStatusCache.updateMany).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.insightStatusCache.updateMany).mock
      .calls[0][0] as {
      where: Record<string, string>;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({
      userId: "u1",
      metric: "weight",
      locale: "en",
    });
    expect(arg.data.dateKey).toBe(TODAY);
    expect(arg.data).not.toHaveProperty("textEncrypted");
    expect(arg.data).not.toHaveProperty("snapshotHash");
    expect(hit?.updatedAt).toBe((arg.data.generatedAt as Date).toISOString());
    expect(prisma.insightStatusCache.upsert).not.toHaveBeenCalled();
  });

  it("misses (and writes nothing) when the stored hash differs", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        dateKey: "2026-05-30",
        text: "Older text.",
        snapshotHash: "b".repeat(64),
      }) as never,
    );
    const hit = await refreshUnchangedStatusInsight({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      snapshotHash: HASH,
    });
    expect(hit).toBeNull();
    expect(prisma.insightStatusCache.updateMany).not.toHaveBeenCalled();
  });

  it("misses when the row carries no hash", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({ dateKey: "2026-05-30", text: "Older text." }) as never,
    );
    const hit = await refreshUnchangedStatusInsight({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      snapshotHash: HASH,
    });
    expect(hit).toBeNull();
    expect(prisma.insightStatusCache.updateMany).not.toHaveBeenCalled();
  });

  it("never refreshes off a row that carries only a negative window", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        text: null,
        generatedAt: null,
        snapshotHash: HASH,
        retryAt: new Date(Date.now() + 60_000),
        negativeReason: "timeout",
      }) as never,
    );
    const hit = await refreshUnchangedStatusInsight({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      snapshotHash: HASH,
    });
    expect(hit).toBeNull();
    expect(prisma.insightStatusCache.updateMany).not.toHaveBeenCalled();
  });

  it("misses on no prior row and on an undecryptable note", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValueOnce(
      null as never,
    );
    expect(
      await refreshUnchangedStatusInsight({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
        todayKey: TODAY,
        snapshotHash: HASH,
      }),
    ).toBeNull();

    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValueOnce(
      noteRow({
        textEncrypted: new TextEncoder().encode("{not ciphertext"),
        snapshotHash: HASH,
      }) as never,
    );
    expect(
      await refreshUnchangedStatusInsight({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
        todayKey: TODAY,
        snapshotHash: HASH,
      }),
    ).toBeNull();
    expect(prisma.insightStatusCache.updateMany).not.toHaveBeenCalled();
  });
});

describe("computeStatusInputFingerprint (v1.18.11 P6)", () => {
  it("is stable across group order and flips when a count or newest moves", async () => {
    const t0 = new Date("2026-05-30T08:00:00.000Z");
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      { type: "WEIGHT", _count: { _all: 10 }, _max: { measuredAt: t0 } },
      {
        type: "BLOOD_PRESSURE_SYS",
        _count: { _all: 3 },
        _max: { measuredAt: t0 },
      },
    ] as never);
    const a = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT", "BLOOD_PRESSURE_SYS"],
    });

    // Same data, reversed group order → identical fingerprint.
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "BLOOD_PRESSURE_SYS",
        _count: { _all: 3 },
        _max: { measuredAt: t0 },
      },
      { type: "WEIGHT", _count: { _all: 10 }, _max: { measuredAt: t0 } },
    ] as never);
    const b = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT", "BLOOD_PRESSURE_SYS"],
    });
    expect(b).toBe(a);

    // One more reading → count moves → fingerprint flips.
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      { type: "WEIGHT", _count: { _all: 11 }, _max: { measuredAt: t0 } },
      {
        type: "BLOOD_PRESSURE_SYS",
        _count: { _all: 3 },
        _max: { measuredAt: t0 },
      },
    ] as never);
    const c = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT", "BLOOD_PRESSURE_SYS"],
    });
    expect(c).not.toBe(a);
  });

  it("flips when a correlation-discovery channel moves (P6-tighten)", async () => {
    const t0 = new Date("2026-05-30T08:00:00.000Z");
    // The card's own metric (WEIGHT) is steady across both probes; only a
    // discovery BEHAVIOUR channel (steps) gains rows. Without the channel
    // coverage the gate would re-stamp the stale assessment and a newly
    // discoverable "steps → next-day weight" relation would never surface.
    const weightOnly = [
      { type: "WEIGHT", _count: { _all: 10 }, _max: { measuredAt: t0 } },
    ];
    vi.mocked(prisma.measurement.groupBy).mockResolvedValueOnce(
      weightOnly as never,
    );
    const before = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeCorrelationChannels: true,
    });

    // A new ACTIVITY_STEPS reading (a discovery channel, NOT the card's own
    // type) appears — the grouped probe now returns it.
    vi.mocked(prisma.measurement.groupBy).mockResolvedValueOnce([
      ...weightOnly,
      {
        type: "ACTIVITY_STEPS",
        _count: { _all: 30 },
        _max: { measuredAt: t0 },
      },
    ] as never);
    const after = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeCorrelationChannels: true,
    });
    expect(after).not.toBe(before);
  });

  it("folds opted-in custom metric configuration and entries into the fingerprint", async () => {
    const t0 = new Date("2026-05-30T08:00:00.000Z");
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.customMetric.findMany)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        {
          id: "custom-1",
          unit: "kg",
          updatedAt: t0,
          _count: { entries: 1 },
          entries: [{ measuredAt: t0, unit: "kg" }],
        },
      ] as never);

    const before = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeCorrelationChannels: true,
    });
    const after = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeCorrelationChannels: true,
    });

    expect(after).not.toBe(before);
    expect(prisma.customMetric.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          userId: "u1",
          deletedAt: null,
          correlationEnabled: true,
        },
      }),
    );
  });

  it("widens the grouped query by the discovery channels only when asked", async () => {
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([] as never);
    await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
    });
    const narrow = vi.mocked(prisma.measurement.groupBy).mock.calls[0][0] as {
      where: { type: { in: string[] } };
    };
    // No channel widening — exactly the card's own types.
    expect(narrow.where.type.in).toEqual(["WEIGHT"]);

    vi.mocked(prisma.measurement.groupBy).mockClear();
    await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeCorrelationChannels: true,
    });
    const wide = vi.mocked(prisma.measurement.groupBy).mock.calls[0][0] as {
      where: { type: { in: string[] } };
    };
    // The card's own type is present exactly once (de-duped against the
    // discovery channel set, which also carries WEIGHT as an outcome).
    expect(wide.where.type.in.filter((t) => t === "WEIGHT")).toHaveLength(1);
    // A behaviour channel the card never reads on its own is now folded in.
    expect(wide.where.type.in).toContain("ACTIVITY_STEPS");
    expect(wide.where.type.in).toContain("SLEEP_DURATION");
    // MOOD is mood-entry backed, not a measurement type — never in the IN set.
    expect(wide.where.type.in).not.toContain("MOOD");
  });

  it("folds mood and extra inputs into the hash when requested", async () => {
    vi.mocked(prisma.measurement.groupBy).mockResolvedValue([
      {
        type: "WEIGHT",
        _count: { _all: 5 },
        _max: { measuredAt: new Date("2026-05-30T08:00:00.000Z") },
      },
    ] as never);
    vi.mocked(prisma.moodEntry.aggregate).mockResolvedValue({
      _count: { _all: 2 },
      _max: { moodLoggedAt: new Date("2026-05-29T20:00:00.000Z") },
    } as never);

    const withMood = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeMood: true,
    });
    const heightChanged = await computeStatusInputFingerprint({
      userId: "u1",
      types: ["WEIGHT"],
      includeMood: true,
      extra: { heightCm: 180 },
    });
    expect(heightChanged).not.toBe(withMood);
    // moodEntry.aggregate is only queried when includeMood is set.
    await computeStatusInputFingerprint({ userId: "u1", types: ["WEIGHT"] });
    expect(prisma.moodEntry.aggregate).toHaveBeenCalledTimes(2);
  });
});

describe("gateUnchangedStatusInput (v1.18.11 P6)", () => {
  const INPUT = "b".repeat(64);

  it("re-dates the cached text and skips the build on a matching input hash", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        dateKey: "2026-05-30",
        text: "Stable weight.",
        inputHash: INPUT,
        snapshotHash: "c".repeat(64),
      }) as never,
    );
    vi.mocked(prisma.insightStatusCache.updateMany).mockResolvedValue(
      {} as never,
    );

    const hit = await gateUnchangedStatusInput({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      inputHash: INPUT,
      force: false,
    });
    expect(hit?.text).toBe("Stable weight.");
    const data = (
      vi.mocked(prisma.insightStatusCache.updateMany).mock.calls[0][0] as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(data.dateKey).toBe(TODAY);
    // The prior fingerprints are preserved (not rewritten) so the next day's
    // gates match.
    expect(data).not.toHaveProperty("inputHash");
    expect(data).not.toHaveProperty("snapshotHash");
  });

  it("misses on a differing or missing input hash (caller builds)", async () => {
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        dateKey: "2026-05-30",
        text: "Stable weight.",
        // no inputHash on the row
      }) as never,
    );
    expect(
      await gateUnchangedStatusInput({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
        todayKey: TODAY,
        inputHash: INPUT,
        force: false,
      }),
    ).toBeNull();
    expect(prisma.insightStatusCache.updateMany).not.toHaveBeenCalled();
  });

  it("misses on a forced run without touching the cache", async () => {
    expect(
      await gateUnchangedStatusInput({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
        todayKey: TODAY,
        inputHash: INPUT,
        force: true,
      }),
    ).toBeNull();
    expect(prisma.insightStatusCache.findUnique).not.toHaveBeenCalled();
  });

  it("misses when statusText is unavailable (no stale re-date)", async () => {
    aiCapabilityForRecord.mockResolvedValue({
      available: false,
      reason: "operator_disabled",
      onDeviceAllowed: false,
    });
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({ text: "Stable weight.", inputHash: INPUT }) as never,
    );
    expect(
      await gateUnchangedStatusInput({
        userId: "u1",
        cacheAction: "insights.weight-status.en",
        todayKey: TODAY,
        inputHash: INPUT,
        force: false,
      }),
    ).toBeNull();
    expect(prisma.insightStatusCache.updateMany).not.toHaveBeenCalled();
  });
});
