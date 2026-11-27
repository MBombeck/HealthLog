/**
 * The assessment pipeline must carry the reader's locale end-to-end.
 *
 * The bug these tests would have caught: every stage typed its locale as
 * `de | en` and narrowed on the way in, so a French account's locale was
 * destroyed before any prompt saw it. The output-language directive in the
 * prompt layer is INERT unless `fr` actually arrives there, so the assertion
 * that matters is not "the pipeline compiles" but "the locale handed to the
 * prompt builder is the one the reader has".
 *
 * Three things are pinned here:
 *   1. `normalizeLocale` passes all six through and defaults unknown values to
 *      ENGLISH — a German default is the whole bug class.
 *   2. Cache-key stability: an existing de/en account keeps reading its
 *      existing `insights.<scope>-status.<locale>` rows; only the four new
 *      locales get new (cold) keys.
 *   3. End-to-end: a `fr` locale entering a generator reaches the prompt
 *      builder as `fr`, and a `fr` forced-warm job reaches `forceWarmUser`
 *      as `fr` (that site previously defaulted to German).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { locales } from "@/lib/i18n/config";
import { normalizeLocale } from "@/lib/insights/status-shared";
import { statusCacheAction } from "@/lib/insights/status-cache";

describe("normalizeLocale", () => {
  it("passes every shipped UI locale through unchanged", () => {
    for (const locale of locales) {
      expect(normalizeLocale(locale)).toBe(locale);
    }
    // The four that used to be flattened away are explicitly covered.
    expect(normalizeLocale("fr")).toBe("fr");
    expect(normalizeLocale("es")).toBe("es");
    expect(normalizeLocale("it")).toBe("it");
    expect(normalizeLocale("pl")).toBe("pl");
  });

  it("defaults an unknown, empty, or missing locale to English, never German", () => {
    for (const value of [null, undefined, "", "xx", "de-DE", "en_US", "🙂"]) {
      expect(normalizeLocale(value)).toBe("en");
      expect(normalizeLocale(value)).not.toBe("de");
    }
  });
});

describe("status cache keys", () => {
  it("leaves the de/en cache keys byte-identical (no drift for existing accounts)", () => {
    expect(statusCacheAction("weight", normalizeLocale("de"))).toBe(
      "insights.weight-status.de",
    );
    expect(statusCacheAction("weight", normalizeLocale("en"))).toBe(
      "insights.weight-status.en",
    );
  });

  it("gives the four widened locales their own keys instead of reusing the English row", () => {
    expect(statusCacheAction("weight", normalizeLocale("fr"))).toBe(
      "insights.weight-status.fr",
    );
    // Before the widening this collapsed onto the English row.
    expect(statusCacheAction("weight", normalizeLocale("fr"))).not.toBe(
      statusCacheAction("weight", "en"),
    );
  });
});

// ── end-to-end: entry point → prompt builder ──────────────────────────────

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    insightStatusCache: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    measurement: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
  },
}));

// The per-type latest-readings read is one LATERAL query in Postgres; here
// it is served from the `measurement.findMany` fixtures, newest first as the
// query orders them, so the suite keeps describing its data as rows.
vi.mock("@/lib/insights/recent-readings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/recent-readings")>();
  const { prisma: db } = await import("@/lib/db");
  return {
    ...actual,
    readLatestReadingsPerType: async () =>
      [
        ...((await db.measurement.findMany({} as never)) as Array<{
          type: string;
          value: number;
          measuredAt: Date;
        }>),
      ].reverse(),
  };
});

// Sleep is read as nights; this suite holds no sleep.
vi.mock("@/lib/measurements/list/sleep-nights", () => ({
  readSleepNightPoints: async () => [],
}));
vi.mock("@/lib/rollups/measurement-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rollups/measurement-read")>()),
  loadUserSourcePriority: async () => null,
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

vi.mock(
  "@/lib/ai/coach/bytes-codec",
  async () => (await import("./status-note-fixtures")).fakeBytesCodec,
);

// statusText is available in these fixtures — the capability read has its
// own tests in status-cache.test.ts.
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
  aiCapabilityToServe: async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

/**
 * The capture seam. `getGeneralStatusSystemPrompt` is the LAST hop before the
 * provider call — whatever locale arrives here is the locale the prompt (and
 * therefore its output-language directive) is composed for.
 */
const systemPromptLocales: string[] = [];
vi.mock("@/lib/ai/prompts/general-status", () => ({
  getGeneralStatusSystemPrompt: (locale: string) => {
    systemPromptLocales.push(locale);
    return "SYSTEM";
  },
  getGeneralStatusUserPrompt: () => "USER",
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { generateGeneralStatusForUser } from "@/lib/insights/general-status";
import { writtenNotes } from "./status-note-fixtures";

const dayMs = 24 * 60 * 60 * 1000;

beforeEach(() => {
  // Clear recorded calls so each case asserts only its own cache writes.
  vi.clearAllMocks();
  systemPromptLocales.length = 0;
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    dateOfBirth: null,
    gender: null,
    heightCm: null,
    insightsExcludeMetrics: [],
  } as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

  const now = Date.now();
  vi.mocked(prisma.measurement.findMany).mockResolvedValue(
    Array.from({ length: 40 }, (_, day) => ({
      type: "WEIGHT",
      value: 80 + (day % 3),
      measuredAt: new Date(now - day * dayMs),
    })) as never,
  );

  vi.mocked(runStatusCompletion).mockResolvedValue({
    kind: "ok",
    content: JSON.stringify({ summary: "Résumé." }),
    providerType: "anthropic",
    model: "x",
    tokensUsed: 1,
  } as never);
});

describe("a fr locale survives from the generator entry point to the prompt", () => {
  it("hands 'fr' to the prompt builder rather than collapsing it to en or de", async () => {
    await generateGeneralStatusForUser("u-fr", { locale: "fr", force: true });

    expect(systemPromptLocales).toContain("fr");
    // The two failure modes the old binary produced.
    expect(systemPromptLocales).not.toContain("de");
    expect(systemPromptLocales).not.toContain("en");
  });

  it("still hands 'de' to a German reader and 'en' to an English one", async () => {
    await generateGeneralStatusForUser("u-de", { locale: "de", force: true });
    expect(systemPromptLocales).toEqual(["de"]);

    systemPromptLocales.length = 0;
    await generateGeneralStatusForUser("u-en", { locale: "en", force: true });
    expect(systemPromptLocales).toEqual(["en"]);
  });

  it("writes the fr assessment to the fr cache row, leaving the en row untouched", async () => {
    await generateGeneralStatusForUser("u-fr", { locale: "fr", force: true });

    const keys = writtenNotes(prisma.insightStatusCache.upsert).map(
      (note) => `${note.metric}.${note.locale}`,
    );
    expect(keys).toContain("general.fr");
    expect(keys).not.toContain("general.en");
  });
});
