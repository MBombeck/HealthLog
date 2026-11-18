/**
 * The seizure quick log (#1368): one screen, a type chip row, one big
 * start/stop button, and the plan with an emergency call once the timer passes
 * the type's threshold. The repo convention is static markup, so the timer
 * hook is driven through a mock: what matters here is what each state shows.
 *
 * Mutation checks (each run, each seen red):
 *   - render the threshold panel without the `overThreshold` condition →
 *     "shows nothing about waiting before the threshold" goes red;
 *   - hard-code "112" instead of the locale's emergency number → "calls the
 *     emergency number of the reader's region" goes red;
 *   - drop the `canLog` gate → "a reader who may not log gets no start
 *     button" goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { SeizureTypeDTO } from "@/lib/seizures/shared";

import { elapsedSeconds, timerStorageKey } from "../use-seizure-timer";

const timer = vi.hoisted(() => ({
  state: null as null | {
    startedAt: string;
    typeProfileId: string | null;
    rescue: unknown[];
  },
  elapsed: 0,
}));

vi.mock("../use-seizure-timer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../use-seizure-timer")>()),
  useSeizureTimer: () => ({
    state: timer.state,
    running: timer.state !== null,
    elapsed: timer.elapsed,
    start: vi.fn(),
    setType: vi.fn(),
    stampRescue: vi.fn(),
    clear: vi.fn(),
  }),
}));

vi.mock("../use-seizures", () => ({
  useSeizureEventMutations: () => ({
    create: { isPending: false, mutateAsync: vi.fn() },
  }),
}));

import { QuickLogCard } from "../quick-log-card";

const BIG: SeizureTypeDTO = {
  id: "t1",
  label: "The big one",
  ilaeType: "FOCAL_TO_BILATERAL_TC",
  usualDurationSec: 60,
  rescuePlan: "Give buccal midazolam, lie on the side.",
  rescueMedicationId: "m1",
  rescueMedicationName: "Midazolam",
  rescueDoseAmount: 10,
  rescueDoseUnit: "mg",
  rescueRoute: "BUCCAL",
  sortOrder: 0,
  archived: false,
  alert: { seconds: 180, source: "usualPlusTwo" },
};

function render(opts: { canLog?: boolean; locale?: "en" | "de" | "ko" } = {}) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={opts.locale ?? "en"}>
      <QuickLogCard
        recordId="child-1"
        types={[BIG]}
        lastTypeId="t1"
        canLog={opts.canLog ?? true}
        onRecorded={() => {}}
        onLogPast={() => {}}
      />
    </I18nProvider>,
  );
}

describe("QuickLogCard", () => {
  it("offers one start button and the person's own types, the last one picked", () => {
    timer.state = null;
    const html = render();
    expect(html).toContain('data-slot="seizure-start"');
    expect(html).not.toContain('data-slot="seizure-stop"');
    expect(html).toContain("The big one");
    expect(html).toMatch(/aria-pressed="true"[^>]*>The big one/);
  });

  it("always shows the emergency guidance", () => {
    timer.state = null;
    expect(render()).toContain('data-slot="seizure-safety"');
  });

  it("a reader who may not log gets no start button", () => {
    timer.state = null;
    expect(render({ canLog: false })).not.toContain(
      'data-slot="seizure-start"',
    );
  });

  it("shows stop, the elapsed time and the rescue button while running", () => {
    timer.state = {
      startedAt: "2026-03-01T08:00:00.000Z",
      typeProfileId: "t1",
      rescue: [],
    };
    timer.elapsed = 65;
    const html = render();
    expect(html).toContain('data-slot="seizure-stop"');
    expect(html).toContain("1:05");
    expect(html).toContain('data-slot="seizure-rescue"');
  });

  it("shows nothing about waiting before the threshold", () => {
    timer.state = {
      startedAt: "2026-03-01T08:00:00.000Z",
      typeProfileId: "t1",
      rescue: [],
    };
    timer.elapsed = 179;
    const html = render();
    expect(html).not.toContain('data-slot="seizure-threshold"');
    expect(html).not.toContain("Give buccal midazolam");
  });

  it("shows the person's plan and a call button once the threshold passes", () => {
    timer.state = {
      startedAt: "2026-03-01T08:00:00.000Z",
      typeProfileId: "t1",
      rescue: [],
    };
    timer.elapsed = 180;
    const html = render();
    expect(html).toContain('data-slot="seizure-threshold"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Give buccal midazolam, lie on the side.");
    expect(html).toContain('href="tel:112"');
  });

  it("calls the emergency number of the reader's region", () => {
    timer.state = {
      startedAt: "2026-03-01T08:00:00.000Z",
      typeProfileId: "t1",
      rescue: [],
    };
    timer.elapsed = 600;
    expect(render({ locale: "ko" })).toContain('href="tel:119"');
  });
});

describe("the timer's persistence", () => {
  it("derives the elapsed time from the stored start, so a reload resumes it", () => {
    const start = "2026-03-01T08:00:00.000Z";
    expect(elapsedSeconds(start, Date.parse(start) + 125_400)).toBe(125);
    // A clock that went backwards never shows a negative time.
    expect(elapsedSeconds(start, Date.parse(start) - 5_000)).toBe(0);
  });

  it("keys the stored timer by record, so one person's timer is not another's", () => {
    expect(timerStorageKey("a")).not.toBe(timerStorageKey("b"));
  });
});
