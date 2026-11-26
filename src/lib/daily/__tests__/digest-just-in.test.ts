/**
 * The "just in" fields of the daily digest.
 *
 * Two clocks are under test and they are deliberately different, which is the
 * whole point of this file: the CHIP expires with the news (three hours), the
 * LINE stands for the rest of the local day. Collapsing them onto one clock is
 * the most plausible future regression here — it reads like a simplification
 * and it silently deletes the day's read at lunchtime.
 */
import { describe, it, expect } from "vitest";

import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { MedsTodayBlock } from "@/lib/dashboard/meds-today";
import {
  buildDailyDigest,
  JUST_IN_WINDOW_MS,
  type DailyDigestArrival,
  type DailyDigestInput,
} from "@/lib/daily/digest";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

const t = getServerTranslator("en").t;
const NOW = new Date("2026-07-16T09:00:00.000Z");

function meds(): MedsTodayBlock {
  return {
    activeCount: 0,
    scheduledToday: 0,
    takenToday: 0,
    skippedToday: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    nextDueMedicationName: null,
    nextDueMedicationId: null,
  };
}

function input(over: Partial<DailyDigestInput> = {}): DailyDigestInput {
  return {
    now: NOW,
    ai: DIGEST_AI_AVAILABLE,
    todayEndExclusive: new Date("2026-07-17T00:00:00.000Z"),
    modules: {},
    enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS],
    score: { value: 82, band: "good", delta: 3 },
    briefing: null,
    medsToday: meds(),
    lastNight: { sleep: null, sleepPending: false },
    syncIssues: [],
    preventiveDue: [],
    coachPlans: [],
    tensionWindow: null,
    todayLocalDate: "2026-07-16",
    dismissedItemKeys: new Set<string>(),
    ...over,
  };
}

/** An arrival that landed `agoMs` before NOW. */
function arrival(
  agoMs: number,
  over: Partial<DailyDigestArrival> = {},
): DailyDigestArrival {
  return {
    kind: "sleep_night",
    occurredAt: new Date(NOW.getTime() - agoMs),
    arrivedAt: new Date(NOW.getTime() - agoMs),
    line: null,
    ...over,
  };
}

describe("buildDailyDigest — justIn", () => {
  it("is null when nothing landed today", () => {
    const digest = buildDailyDigest(input(), t);
    expect(digest.justIn).toBeNull();
    expect(digest.reactionLine).toBeNull();
  });

  it("names the arrival and carries an ISO instant, never a formatted time", () => {
    const at = new Date(NOW.getTime() - 60_000);
    const digest = buildDailyDigest(
      input({ arrivals: [arrival(60_000, { kind: "weight" })] }),
      t,
    );

    expect(digest.justIn).toEqual({ kind: "weight", at: at.toISOString() });
    // The wire value must stay machine-readable. A server-formatted wall clock
    // here is the React #418 bug in its exact original shape.
    expect(digest.justIn?.at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("uses landing time when an older sample syncs later", () => {
    const digest = buildDailyDigest(
      input({
        arrivals: [
          arrival(60_000, {
            occurredAt: new Date(NOW.getTime() - 8 * 60 * 60_000),
          }),
        ],
      }),
      t,
    );

    expect(digest.justIn?.at).toBe(
      new Date(NOW.getTime() - 60_000).toISOString(),
    );
  });

  it("shows the chip inside the window and drops it after", () => {
    const inside = buildDailyDigest(
      input({ arrivals: [arrival(JUST_IN_WINDOW_MS - 60_000)] }),
      t,
    );
    expect(inside.justIn).not.toBeNull();

    const outside = buildDailyDigest(
      input({ arrivals: [arrival(JUST_IN_WINDOW_MS + 60_000)] }),
      t,
    );
    expect(outside.justIn).toBeNull();
  });

  it("does not surface a future or invalid arrival as current news", () => {
    const future = arrival(-60_000, {
      kind: "weight",
      line: "This line has not landed yet.",
    });
    const invalid = arrival(60_000, {
      arrivedAt: new Date(Number.NaN),
      line: "Invalid timestamps cannot lead the day.",
    });

    const digest = buildDailyDigest(input({ arrivals: [future, invalid] }), t);

    expect(digest.justIn).toBeNull();
    expect(digest.reactionLine).toBeNull();
  });

  it("ignores a future row and keeps the newest valid arrival", () => {
    const digest = buildDailyDigest(
      input({
        arrivals: [
          arrival(5 * 60_000, { kind: "workout", line: "Grounded arrival." }),
          arrival(-60_000, { kind: "weight", line: "Future row." }),
        ],
      }),
      t,
    );

    expect(digest.justIn?.kind).toBe("workout");
    expect(digest.reactionLine).toBe("Grounded arrival.");
  });

  it("keeps the reaction line after the chip has expired", () => {
    // The load-bearing asymmetry: past the window the record is no longer
    // NEWS, but the sentence is still the day's READ and must survive.
    const digest = buildDailyDigest(
      input({
        arrivals: [
          arrival(JUST_IN_WINDOW_MS + 60 * 60_000, {
            line: "A solid night, deeper than your recent stretch.",
          }),
        ],
      }),
      t,
    );

    expect(digest.justIn).toBeNull();
    expect(digest.reactionLine).toBe(
      "A solid night, deeper than your recent stretch.",
    );
  });

  it("picks the newest arrival when several landed", () => {
    const digest = buildDailyDigest(
      input({
        arrivals: [
          arrival(2 * 60 * 60_000, { kind: "weight", line: "older" }),
          arrival(10 * 60_000, { kind: "workout", line: "newer" }),
          arrival(60 * 60_000, { kind: "blood_pressure", line: "middle" }),
        ],
      }),
      t,
    );

    expect(digest.justIn?.kind).toBe("workout");
    expect(digest.reactionLine).toBe("newer");
  });

  it("picks the latest landing rather than the newest sample timestamp", () => {
    const digest = buildDailyDigest(
      input({
        arrivals: [
          arrival(10 * 60_000, {
            kind: "workout",
            occurredAt: new Date(NOW.getTime() - 4 * 60 * 60_000),
            line: "landed later",
          }),
          arrival(60 * 60_000, {
            kind: "weight",
            occurredAt: new Date(NOW.getTime() - 60_000),
            line: "newer sample",
          }),
        ],
      }),
      t,
    );

    expect(digest.justIn?.kind).toBe("workout");
    expect(digest.reactionLine).toBe("landed later");
  });

  it("treats a blank generated line as absent rather than shipping an empty lead", () => {
    const digest = buildDailyDigest(
      input({ arrivals: [arrival(60_000, { line: "   " })] }),
      t,
    );

    expect(digest.justIn).not.toBeNull();
    expect(digest.reactionLine).toBeNull();
  });

  it("stays pure — the composer never mutates the arrivals it was handed", () => {
    const arrivals = [arrival(60_000), arrival(30_000, { kind: "weight" })];
    const snapshot = JSON.stringify(arrivals);

    buildDailyDigest(input({ arrivals }), t);

    expect(JSON.stringify(arrivals)).toBe(snapshot);
  });
});

describe("buildDailyDigest — the language of each text (#176)", () => {
  const reaction = arrival(60_000, {
    line: "Your resting heart rate held at 54 bpm overnight.",
  });

  it("names the language of every stored text and of the server's own", () => {
    const digest = buildDailyDigest(
      input({
        locale: "en",
        arrivals: [reaction],
        reactionLanguage: "en",
        briefingLanguage: "en",
      }),
      t,
    );
    expect(digest.languages).toEqual({
      response: "en",
      briefing: "en",
      reaction: "en",
    });
    expect(digest.lead).toMatchObject({ source: "reaction", language: "en" });
  });

  it("does not lead with a reaction written in another language", () => {
    const digest = buildDailyDigest(
      input({
        locale: "en",
        arrivals: [
          arrival(60_000, { line: "Dein Ruhepuls lag über Nacht bei 54." }),
        ],
        reactionLanguage: "de",
      }),
      t,
    );
    // Still published, with its language, for a client that wants it.
    expect(digest.reactionLine).toBe("Dein Ruhepuls lag über Nacht bei 54.");
    expect(digest.languages?.reaction).toBe("de");
    // The lead falls to a source in the reader's language.
    expect(digest.lead?.source).not.toBe("reaction");
    if (digest.lead) expect(digest.lead.language).toBe("en");
  });

  it("says when the language of a stored text is not known", () => {
    const digest = buildDailyDigest(input({ arrivals: [reaction] }), t);
    expect(digest.languages).toEqual({
      response: "en",
      briefing: null,
      reaction: null,
    });
    expect(digest.lead).toMatchObject({ source: "reaction", language: null });
  });
});
