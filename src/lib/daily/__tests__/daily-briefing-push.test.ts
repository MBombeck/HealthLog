/**
 * S5 — daily-briefing push decision seam + composer.
 *
 * Pins the once-per-day, opt-in-only, morning-window, non-alert contract of
 * `maybeDispatchDailyBriefing` and the floor/lead composition of
 * `buildDailyBriefingPush`, all without a DB / provider / boss.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

vi.mock("@/lib/daily/load-digest", () => ({ loadDailyDigest: vi.fn() }));

import {
  maybeDispatchDailyBriefing,
  buildDailyBriefingPush,
  digestHasSubstance,
  type DailyBriefingDispatchDeps,
} from "@/lib/daily/daily-briefing-push";
import type { DailyDigest } from "@/lib/daily/digest";
import { isUrgentPayload } from "@/lib/notifications/types";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

// 06:00Z → 08:00 in Europe/Berlin (summer) → inside the morning window AND the
// fixed fallback hour. The tz-window cases move only this instant.
const IN_WINDOW = new Date("2026-07-16T06:00:00Z");
const BEFORE_WINDOW = new Date("2026-07-16T00:30:00Z"); // 02:30 Berlin
const AFTER_WINDOW = new Date("2026-07-16T12:30:00Z"); // 14:30 Berlin

function makeDigest(over: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: "2026-07-16T06:00:00.000Z",
    ai: DIGEST_AI_AVAILABLE,
    phase: "final",
    sleepPending: false,
    score: { value: 82, band: "good", delta: 1 },
    topSignal: null,
    briefingLead: "Sleep looked solid last night.",
    lead: { text: "Sleep looked solid last night.", source: "briefing" },
    today: [],
    restMode: null,
    line: "Sleep looked solid last night.",
    worthALook: [],
    justIn: null,
    reactionLine: null,
    ...over,
  };
}

function makePrisma(opts: {
  user?: unknown;
  optIn?: unknown;
  lastOk?: { createdAt: Date } | null;
}) {
  const user =
    opts.user === undefined
      ? {
          id: "u1",
          timezone: "Europe/Berlin",
          locale: "en",
          morningDigestRefreshedOn: null,
        }
      : opts.user;
  return {
    user: { findUnique: vi.fn(async () => user) },
    notificationPreference: {
      findFirst: vi.fn(async () =>
        opts.optIn === undefined ? { id: "pref1" } : opts.optIn,
      ),
    },
    pushAttempt: { findFirst: vi.fn(async () => opts.lastOk ?? null) },
  } as unknown as PrismaClient;
}

function makeDeps(
  over: Partial<DailyBriefingDispatchDeps> = {},
): DailyBriefingDispatchDeps & { dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(async () => ({
    dispatched: true,
    channelsAttempted: 1,
    channelsSucceeded: 1,
  }));
  return {
    dispatch,
    loadDigest: async () => makeDigest(),
    ...over,
  } as DailyBriefingDispatchDeps & { dispatch: ReturnType<typeof vi.fn> };
}

describe("buildDailyBriefingPush", () => {
  const { t } = getServerTranslator("en");

  it("uses the digest line verbatim as the body when the day is final", () => {
    const digest = makeDigest({ line: "Pulse ran a touch high yesterday." });
    const { title, body } = buildDailyBriefingPush(digest, t);
    expect(body).toBe("Pulse ran a touch high yesterday.");
    expect(title).toBe(t("daily.push.title"));
  });

  it("floor: a no-AI user (no briefing lead) still gets the deterministic line", () => {
    // composeLine's floor already sits in `digest.line`; the push carries it
    // unchanged, so a keyless self-hoster gets a first-class body.
    const digest = makeDigest({
      briefingLead: null,
      topSignal: null,
      line: "Your health score for today is ready.",
    });
    const { body } = buildDailyBriefingPush(digest, t);
    expect(body).toBe("Your health score for today is ready.");
  });

  it("provisional: appends the honest sleep-pending wording", () => {
    const digest = makeDigest({
      sleepPending: true,
      line: "Trends held steady this week.",
    });
    const { body } = buildDailyBriefingPush(digest, t);
    expect(body).toContain("Trends held steady this week.");
    expect(body).not.toBe("Trends held steady this week.");
  });
});

describe("digestHasSubstance", () => {
  it("is false for an empty account (score/lead/signal all null, no items)", () => {
    expect(
      digestHasSubstance(
        makeDigest({
          score: null,
          briefingLead: null,
          topSignal: null,
          worthALook: [],
        }),
      ),
    ).toBe(false);
  });

  it("is true when a score is present", () => {
    expect(
      digestHasSubstance(
        makeDigest({ briefingLead: null, topSignal: null, worthALook: [] }),
      ),
    ).toBe(true);
  });
});

describe("maybeDispatchDailyBriefing", () => {
  it("opted-in + substantive digest + in window → exactly one DAILY_BRIEFING dispatch", async () => {
    const prisma = makePrisma({});
    const deps = makeDeps();
    const result = await maybeDispatchDailyBriefing(
      prisma,
      "u1",
      IN_WINDOW,
      deps,
    );

    expect(result).toBe("sent");
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    const payload = deps.dispatch.mock.calls[0][0];
    expect(payload.eventType).toBe("DAILY_BRIEFING");
    expect(payload.metadata?.url).toBe("/");
  });

  it("uses canonical candidates when dashboard hero visibility hides the only item", async () => {
    vi.mocked(loadDailyDigest).mockReset();
    vi.mocked(loadDailyDigest).mockImplementation(
      async (_user, _now, options) =>
        makeDigest({
          score: null,
          briefingLead: null,
          topSignal: null,
          worthALook: options?.enabledItemKinds?.includes("dose_window")
            ? [
                {
                  kind: "dose_window",
                  title: "Medication due",
                  body: "Morning dose is overdue.",
                  status: "warning",
                  actions: [
                    {
                      labelKey: "daily.action.logDose",
                      intent: "dose.log",
                    },
                  ],
                },
              ]
            : [],
        }),
    );
    const deps = makeDeps();
    delete deps.loadDigest;

    const result = await maybeDispatchDailyBriefing(
      makePrisma({}),
      "u1",
      IN_WINDOW,
      deps,
    );

    expect(result).toBe("sent");
    // The push resolves the locale once (stored, then operator default) and
    // hands it to the digest so both speak the same language.
    expect(loadDailyDigest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      IN_WINDOW,
      { enabledItemKinds: PRIORITY_ITEM_KINDS, locale: "en" },
    );
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it("never routes as an alert: the payload is non-urgent", async () => {
    const prisma = makePrisma({});
    const deps = makeDeps();
    await maybeDispatchDailyBriefing(prisma, "u1", IN_WINDOW, deps);
    const payload = deps.dispatch.mock.calls[0][0];
    // No urgent flag AND not MEDICATION_REMINDER → the urgency classifier is
    // false, so it can never escalate to a time-sensitive / Focus-bypass send.
    expect(payload.urgent).toBeUndefined();
    expect(isUrgentPayload(payload)).toBe(false);
  });

  it("opted-out (no enabled preference) → no dispatch", async () => {
    const prisma = makePrisma({ optIn: null });
    const deps = makeDeps();
    const result = await maybeDispatchDailyBriefing(
      prisma,
      "u1",
      IN_WINDOW,
      deps,
    );
    expect(result).toBe("opted-out");
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("no digest substance → no dispatch", async () => {
    const prisma = makePrisma({});
    const deps = makeDeps({
      loadDigest: async () =>
        makeDigest({
          score: null,
          briefingLead: null,
          topSignal: null,
          worthALook: [],
        }),
    });
    const result = await maybeDispatchDailyBriefing(
      prisma,
      "u1",
      IN_WINDOW,
      deps,
    );
    expect(result).toBe("no-digest");
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("AI analysis off: the push still goes out with the deterministic line", async () => {
    // The digest the loader returns when the briefing capability is
    // unavailable: no lead, no top signal, the score floor as the line.
    const prisma = makePrisma({});
    const deps = makeDeps({
      loadDigest: async () =>
        makeDigest({
          briefingLead: null,
          topSignal: null,
          line: "Your health score today is 82.",
        }),
    });
    const result = await maybeDispatchDailyBriefing(
      prisma,
      "u1",
      IN_WINDOW,
      deps,
    );
    expect(result).toBe("sent");
    const payload = JSON.stringify(deps.dispatch.mock.calls[0]);
    expect(payload).toContain("Your health score today is 82.");
  });

  it("frequency cap: an ok ledger row earlier the SAME local day suppresses the second push", async () => {
    const prisma = makePrisma({
      // 04:00Z → 06:00 Berlin, same local day as the 08:00 attempt.
      lastOk: { createdAt: new Date("2026-07-16T04:00:00Z") },
    });
    const deps = makeDeps();
    const result = await maybeDispatchDailyBriefing(
      prisma,
      "u1",
      IN_WINDOW,
      deps,
    );
    expect(result).toBe("suppressed-frequency");
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("frequency cap: an ok ledger row on the PREVIOUS local day does not suppress", async () => {
    const prisma = makePrisma({
      // 20:00Z on the 15th → 22:00 Berlin on the 15th → previous local day.
      lastOk: { createdAt: new Date("2026-07-15T20:00:00Z") },
    });
    const deps = makeDeps();
    const result = await maybeDispatchDailyBriefing(
      prisma,
      "u1",
      IN_WINDOW,
      deps,
    );
    expect(result).toBe("sent");
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it("tz timing: before the local morning window → no dispatch", async () => {
    const prisma = makePrisma({});
    const deps = makeDeps();
    const result = await maybeDispatchDailyBriefing(
      prisma,
      "u1",
      BEFORE_WINDOW,
      deps,
    );
    expect(result).toBe("outside-window");
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("tz timing: after the local morning window → no dispatch", async () => {
    const prisma = makePrisma({});
    const deps = makeDeps();
    const result = await maybeDispatchDailyBriefing(
      prisma,
      "u1",
      AFTER_WINDOW,
      deps,
    );
    expect(result).toBe("outside-window");
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("no channel delivered → no-channel (ledger slot left free)", async () => {
    const prisma = makePrisma({});
    const deps = makeDeps({
      dispatch: vi.fn(async () => ({
        dispatched: false,
        channelsAttempted: 0,
        channelsSucceeded: 0,
      })) as unknown as DailyBriefingDispatchDeps["dispatch"],
    });
    const result = await maybeDispatchDailyBriefing(
      prisma,
      "u1",
      IN_WINDOW,
      deps,
    );
    expect(result).toBe("no-channel");
  });

  it("missing user → missing-user, never throws", async () => {
    const prisma = makePrisma({ user: null });
    const deps = makeDeps();
    const result = await maybeDispatchDailyBriefing(
      prisma,
      "u1",
      IN_WINDOW,
      deps,
    );
    expect(result).toBe("missing-user");
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});
