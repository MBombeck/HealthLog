import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { pluralKey } from "@/lib/i18n/plural";
import type { Locale } from "@/lib/i18n/config";
import type { CoachActivity, CoachStep } from "@/lib/ai/coach/types";

import {
  CoachTurnActivity,
  CoachTurnStepList,
  activityLineLabel,
  activitySeconds,
  activitySummary,
  countLookups,
  countSources,
  currentActivity,
  currentStep,
  describeStep,
  legacyAreaLabels,
  stepLabel,
} from "../turn-activity";

function render(node: React.ReactNode, locale: Locale = "en") {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

function translators(locale: Locale) {
  const { t } = getServerTranslator(locale);
  const tCount = (base: string, count: number) =>
    t(pluralKey(base, count, locale), { count });
  return { t, tCount };
}

const BP: CoachStep = {
  id: "s1",
  tool: "get_metric_series",
  labelKey: "coach.step.readWindow",
  label: "Checking: Blood pressure, last 90 days",
  domain: "bp",
  window: "last90days",
  status: "done",
  count: 142,
};
const SLEEP: CoachStep = {
  id: "s2",
  tool: "get_sleep",
  labelKey: "coach.step.readWindow",
  label: "Checking: Sleep, last 30 days",
  domain: "sleep",
  window: "last30days",
  status: "empty",
  reason: "no_data",
};
const LABS_RUNNING: CoachStep = {
  id: "s3",
  tool: "get_labs",
  labelKey: "coach.step.readWindow",
  label: "Checking: Lab results, last 12 months",
  domain: "labs",
  window: "lastYear",
  status: "running",
};

describe("describeStep", () => {
  const { t, tCount } = translators("en");

  it("reads domain · window · count on a found step", () => {
    expect(describeStep(BP, t, tCount)).toEqual({
      title: "Blood pressure",
      meta: ["last 90 days", "142 readings"],
    });
  });

  it("says why nothing was found on an empty step", () => {
    expect(describeStep(SLEEP, t, tCount)).toEqual({
      title: "Sleep",
      meta: ["last 30 days", "no readings"],
    });
  });

  it("shows no count on a miss, even when the record holds rows elsewhere", () => {
    const outside: CoachStep = {
      ...SLEEP,
      reason: "outside_window",
      count: 40,
    };
    expect(describeStep(outside, t, tCount).meta).toEqual([
      "last 30 days",
      "no readings in this window",
    ]);
  });

  it("counts metrics on the snapshot step and rows on labs", () => {
    const snapshot: CoachStep = {
      id: "s1",
      tool: "snapshot",
      labelKey: "coach.step.snapshot",
      label: "Reading your record summary",
      domain: "snapshot",
      status: "done",
      count: 1,
    };
    expect(describeStep(snapshot, t, tCount)).toEqual({
      title: "Record summary",
      meta: ["1 metric"],
    });
    expect(
      describeStep({ ...LABS_RUNNING, status: "done", count: 3 }, t, tCount)
        .meta,
    ).toEqual(["last 12 months", "3 rows"]);
  });

  it("renders in the reader's language from the keys, not the server label", () => {
    const de = translators("de");
    expect(stepLabel(BP, de.t)).toBe("Prüfe: Blutdruck, letzte 90 Tage");
    expect(describeStep(BP, de.t, de.tCount).meta).toEqual([
      "letzte 90 Tage",
      "142 Messwerte",
    ]);
  });

  it("falls back to the server label for a key the bundle lacks", () => {
    expect(stepLabel({ ...BP, labelKey: "coach.step.fromTheFuture" }, t)).toBe(
      BP.label,
    );
  });
});

const THINKING_RUNNING: CoachActivity = {
  id: "a1",
  phase: "thinking",
  status: "running",
  round: 1,
  labelKey: "insights.coach.activity.thinking",
  label: "Thinking…",
};
const FETCH_BP: CoachActivity = {
  id: "a2",
  phase: "fetch",
  status: "done",
  round: 1,
  labelKey: "insights.coach.activity.fetching",
  label: "Fetching blood pressure, last 90 days…",
  stepRef: "s1",
  durationMs: 900,
};
const FETCH_SLEEP: CoachActivity = {
  id: "a3",
  phase: "fetch",
  status: "empty",
  round: 1,
  labelKey: "insights.coach.activity.fetching",
  label: "Fetching sleep, last 30 days…",
  stepRef: "s2",
  durationMs: 1_400,
};
const DIGEST_RUNNING: CoachActivity = {
  id: "a4",
  phase: "digest",
  status: "running",
  round: 1,
  labelKey: "insights.coach.activity.digestOther",
  label: "Summarising 214 readings…",
  count: 214,
};
const THINKING_DONE: CoachActivity = {
  ...THINKING_RUNNING,
  status: "done",
  durationMs: 4_000,
  title: "Comparing the two months",
  text: "The second half of the month runs higher.",
};
const DIGEST_DONE: CoachActivity = {
  ...DIGEST_RUNNING,
  status: "done",
  label: "214 readings from 2 areas",
  durationMs: 600,
};
const ANSWER_DONE: CoachActivity = {
  id: "a5",
  phase: "answer",
  status: "done",
  round: 2,
  labelKey: "insights.coach.activity.answer",
  label: "Writing the answer…",
  durationMs: 6_000,
};
const ASKING: CoachActivity = {
  id: "a6",
  phase: "asking",
  status: "done",
  round: 1,
  labelKey: "insights.coach.activity.asking",
  label: "Asking you…",
  durationMs: 1_000,
};
const STOPPED: CoachActivity = {
  id: "a7",
  phase: "stop",
  status: "done",
  round: 6,
  labelKey: "insights.coach.activity.stop.time",
  label: "Time limit reached, answering with what it has",
  stop: "time",
};
const SETTLED = [
  THINKING_DONE,
  FETCH_BP,
  FETCH_SLEEP,
  DIGEST_DONE,
  ANSWER_DONE,
];

describe("the running line", () => {
  it("names the latest running entry, else the latest one", () => {
    expect(currentActivity([THINKING_DONE, FETCH_BP, DIGEST_RUNNING])?.id).toBe(
      "a4",
    );
    expect(currentActivity([THINKING_DONE, FETCH_BP])?.id).toBe("a2");
    expect(currentActivity([])).toBeNull();
  });

  it("shows a reasoning title once one arrives, the catalog label before", () => {
    expect(activityLineLabel(THINKING_RUNNING)).toBe("Thinking…");
    expect(
      activityLineLabel({ ...THINKING_RUNNING, title: "Checking the trend" }),
    ).toBe("Checking the trend");
    // Model text never replaces a fetch's catalog label, and a finished
    // entry no longer trails off.
    expect(activityLineLabel({ ...FETCH_BP, title: "x" })).toBe(
      "Fetching blood pressure, last 90 days",
    );
    expect(
      activityLineLabel({ ...FETCH_BP, status: "running", title: "x" }),
    ).toBe("Fetching blood pressure, last 90 days…");
  });

  it("walks thinking → fetching → summarising, one quiet line", () => {
    const frames = [
      [THINKING_RUNNING],
      [
        { ...THINKING_RUNNING, status: "done" as const },
        { ...FETCH_BP, status: "running" as const },
      ],
      [THINKING_DONE, FETCH_BP, DIGEST_RUNNING],
    ];
    const lines = frames.map((activity) =>
      render(
        <CoachTurnActivity
          activity={activity}
          steps={[]}
          active
          startedAt={Date.now() - 12_000}
        />,
      ),
    );
    expect(lines[0]).toContain(">Thinking…<");
    expect(lines[1]).toContain(">Fetching blood pressure, last 90 days…<");
    expect(lines[2]).toContain(">Summarising 214 readings…<");
    for (const html of lines) {
      expect(html.match(/data-slot="coach-turn-steps-toggle"/g)).toHaveLength(
        1,
      );
      expect(html).toContain('data-state="running"');
      expect(html).toContain('aria-label="Show what the Coach looked at"');
      // The seconds so far follow the text directly, in the line's own
      // muted tone, with the summary's spacing ("12 s"), never pushed to
      // the far edge of the column.
      expect(html).toMatch(
        /data-slot="coach-turn-steps-active"[^>]*>[^<]*<\/span><span[^>]*data-slot="coach-turn-steps-seconds"[^>]*>1[23]\u00a0s</,
      );
      const seconds = html.match(
        /<span[^>]*data-slot="coach-turn-steps-seconds"[^>]*>/,
      )?.[0];
      expect(seconds).toContain("tabular-nums");
      expect(seconds).not.toMatch(/\bml-auto\b|text-foreground/);
    }
  });

  it("says Thinking… before the first frame arrives", () => {
    const html = render(<CoachTurnActivity activity={[]} steps={[]} active />);
    expect(html).toContain(">Thinking…<");
    expect(html).toContain('aria-expanded="false"');
  });

  it("falls back to the step label on a server that sends only steps", () => {
    const html = render(
      <CoachTurnActivity activity={[]} steps={[BP, LABS_RUNNING]} active />,
    );
    expect(html).toContain("Checking: Lab results, last 12 months");
  });
});

describe("nothing opens by itself", () => {
  const states: Array<[string, React.ReactNode]> = [
    [
      "before any frame",
      <CoachTurnActivity key="0" activity={[]} steps={[]} active />,
    ],
    [
      "running",
      <CoachTurnActivity
        key="1"
        activity={[THINKING_DONE, FETCH_BP, DIGEST_RUNNING]}
        steps={[BP]}
        active
      />,
    ],
    [
      "asking",
      <CoachTurnActivity
        key="2"
        activity={[THINKING_DONE, ASKING]}
        steps={[]}
        active={false}
      />,
    ],
    [
      "stopped",
      <CoachTurnActivity
        key="3"
        activity={[...SETTLED, STOPPED]}
        steps={[BP, SLEEP]}
        active={false}
      />,
    ],
    [
      "settled",
      <CoachTurnActivity
        key="4"
        activity={SETTLED}
        steps={[BP, SLEEP]}
        active={false}
        method={{ entries: [], text: "Blood pressure, 9 readings." }}
        dataUsed={<div data-slot="coach-data-used" />}
      />,
    ],
    [
      "reloaded (metadata only)",
      <CoachTurnActivity
        key="5"
        activity={JSON.parse(
          JSON.stringify(
            SETTLED.map(({ title: _t, text: _x, ...meta }) => meta),
          ),
        )}
        steps={[BP, SLEEP]}
        active={false}
        conversationId="c1"
        messageId="m1"
      />,
    ],
    [
      "legacy steps",
      <CoachTurnActivity
        key="6"
        activity={[]}
        steps={[BP, SLEEP]}
        active={false}
      />,
    ],
  ];
  for (const [name, node] of states) {
    it(`is closed when ${name}`, () => {
      const html = render(node);
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain('aria-expanded="true"');
      expect(html).not.toContain('data-slot="coach-turn-steps-panel"');
      expect(html).not.toContain('data-slot="coach-turn-step-detail"');
      expect(html).not.toContain("The second half of the month runs higher.");
    });
  }
});

describe("after the answer", () => {
  const { t } = translators("en");

  it("collapses to one calm summary of lookups and seconds", () => {
    const html = render(
      <CoachTurnActivity
        activity={SETTLED}
        steps={[BP, SLEEP]}
        active={false}
      />,
    );
    expect(html).toContain('data-state="done"');
    expect(html).toContain(
      'data-slot="coach-turn-steps-done" class="min-w-0 truncate">Thought it through, 2 lookups, 12 s<',
    );
    // No spinner, no running seconds, no stable-name override once settled.
    expect(html).not.toContain("coach-turn-steps-spinner");
    expect(html).not.toContain("coach-turn-steps-seconds");
    expect(html).not.toContain('aria-label="Show what the Coach looked at"');
  });

  it("counts fetches as lookups and runs a round's fetches side by side", () => {
    expect(countLookups(SETTLED)).toBe(2);
    // 4 s thinking + max(0.9, 1.4) s fetching + 0.6 s digest + 6 s answer.
    expect(activitySeconds(SETTLED)).toBe(12);
    expect(activitySeconds([THINKING_RUNNING])).toBeNull();
  });

  it("uses the live turn's clock when the trail has no durations", () => {
    expect(
      activitySummary({
        activity: [{ ...ANSWER_DONE, durationMs: undefined }],
        startedAt: 1_000,
        endedAt: 19_000,
        t,
        locale: "en",
      }),
    ).toBe("Thought it through, 18 s");
  });

  it("reads in German", () => {
    const html = render(
      <CoachTurnActivity activity={SETTLED} steps={[]} active={false} />,
      "de",
    );
    expect(html).toContain("Nachgedacht, 2 Abfragen, 12 s");
  });

  it("an older message still folds into its sources", () => {
    const html = render(
      <CoachTurnActivity activity={[]} steps={[BP, SLEEP]} active={false} />,
    );
    expect(html).toContain("Looked at 2 sources");
    expect(
      countSources([BP, { ...BP, id: "s9", period: "previous" }, SLEEP]),
    ).toBe(2);
  });

  it("an answer saved before steps folds into its areas", () => {
    expect(
      render(
        <CoachTurnActivity
          activity={[]}
          steps={[]}
          active={false}
          areas={["bp", "sleep"]}
        />,
      ),
    ).toContain("Looked at 2 areas");
    expect(
      render(
        <CoachTurnActivity
          activity={[]}
          steps={[]}
          active={false}
          areas={["bp"]}
        />,
        "de",
      ),
    ).toContain("1 Bereich angesehen");
  });

  it("renders nothing for a settled message with nothing to show", () => {
    expect(
      render(<CoachTurnActivity activity={[]} steps={[]} active={false} />),
    ).not.toContain("coach-turn-steps");
  });

  it("carries a polite status region that starts empty", () => {
    const html = render(
      <CoachTurnActivity activity={SETTLED} steps={[]} active={false} />,
    );
    expect(html).toMatch(
      /<span role="status" aria-live="polite" aria-atomic="true" class="sr-only"><\/span>/,
    );
  });
});

describe("currentStep", () => {
  it("names the latest running step, else the latest step", () => {
    expect(currentStep([BP, LABS_RUNNING, SLEEP])?.id).toBe("s3");
    expect(currentStep([BP, SLEEP])?.id).toBe("s2");
    expect(currentStep([])).toBeNull();
  });
});

describe("tokens and motion", () => {
  it("uses theme tokens only, and every motion stops under reduced motion", () => {
    const html =
      render(
        <CoachTurnActivity
          activity={[THINKING_DONE, FETCH_BP, DIGEST_RUNNING]}
          steps={[BP]}
          active
        />,
      ) +
      render(
        <CoachTurnStepList
          steps={[
            BP,
            SLEEP,
            LABS_RUNNING,
            {
              ...SLEEP,
              id: "s4",
              status: "failed",
              reason: "retrieval_failed",
            },
          ]}
          active
        />,
      );
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|dracula-|\[#|oklch\(/i);
    expect(html).not.toMatch(/text-muted-foreground\/\d/);
    const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) =>
      m[1].split(/\s+/),
    );
    for (const cls of classes) {
      if (cls.startsWith("transition")) {
        throw new Error(`unguarded transition: ${cls}`);
      }
    }
    expect(html).toContain("animate-spin motion-reduce:animate-none");
    // A 44 px tap target on phones.
    expect(html).toContain("min-h-11");
  });
});

describe("<CoachTurnStepList>", () => {
  it("one row per step: domain · window · count or reason, with its status", () => {
    const html = render(
      <CoachTurnStepList steps={[BP, SLEEP, LABS_RUNNING]} active />,
    );
    expect(html).toContain('aria-label="What the Coach looked at"');
    expect(html.match(/data-slot="coach-turn-step"/g)).toHaveLength(3);
    expect(html).toContain('data-status="done"');
    expect(html).toContain('data-status="empty"');
    expect(html).toContain('data-status="running"');
    let text = html.replace(
      /<span class="sr-only select-none">, <\/span>/g,
      "",
    );
    for (let prev = ""; prev !== text;) {
      prev = text;
      text = text.replace(/<[^>]*>/g, "");
    }
    expect(text).toContain("Blood pressure · last 90 days · 142 readings");
    expect(text).toContain("Sleep · last 30 days · no readings");
    expect(text).toContain("Lab results · last 12 months");
  });
});

describe("legacyAreaLabels", () => {
  const { t } = translators("en");

  it("names the known areas and drops unknown tokens and general", () => {
    expect(
      legacyAreaLabels(
        ["bp", "bloodPressure" as never, "general", "sleep", "bp"],
        t,
      ),
    ).toEqual(["Blood pressure", "Sleep"]);
  });
});
