import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { pluralKey } from "@/lib/i18n/plural";
import type { Locale } from "@/lib/i18n/config";
import type { CoachActivity, CoachStep } from "@/lib/ai/coach/types";

import { Brain, ChartScatter, Database, Lightbulb, Table2 } from "lucide-react";

import {
  CoachTurnActivity,
  activityLineLabel,
  currentActivity,
  currentStep,
  describeStep,
  inProgressLabel,
  legacyAreaLabels,
  openAfter,
  stepIcon,
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

/** The row's element (button or plain row) and everything inside it. */
function rowHtml(html: string): string {
  const match = html.match(
    /<(button|div)[^>]*data-slot="coach-turn-steps-(?:toggle|row)"[\s\S]*?<\/\1>/,
  );
  return match?.[0] ?? "";
}

/** The visible text of a fragment, tags removed. */
function textOf(html: string): string {
  let text = html.replace(/<span class="sr-only select-none">, <\/span>/g, "");
  for (let prev = ""; prev !== text;) {
    prev = text;
    text = text.replace(/<[^>]*>/g, "");
  }
  return text;
}

describe("one row while the Coach works", () => {
  it("walks thinking → fetching → summarising on one shimmering row", () => {
    const frames = [
      [THINKING_RUNNING],
      [
        { ...THINKING_RUNNING, status: "done" as const },
        { ...FETCH_BP, status: "running" as const },
      ],
      [THINKING_DONE, FETCH_BP, DIGEST_RUNNING],
    ];
    const htmls = frames.map((activity) =>
      render(<CoachTurnActivity activity={activity} steps={[]} active />),
    );
    expect(htmls[0]).toContain('data-text="Thinking…"');
    expect(htmls[1]).toContain(
      'data-text="Fetching blood pressure, last 90 days…"',
    );
    expect(htmls[2]).toContain('data-text="Summarising 214 readings…"');
    for (const html of htmls) {
      // Exactly one row, and nothing under it while closed.
      expect(
        html.match(/data-slot="coach-turn-steps-(toggle|row)"/g),
      ).toHaveLength(1);
      expect(html).toContain('data-state="running"');
      expect(html).not.toContain("coach-interim");
      expect(html).not.toContain('<svg viewBox="0 0 48 16"');
      // The words shimmer; the trailing dots fade on their own.
      expect(html).toMatch(/<span class="text-shimmer">[^<]+<\/span>/);
      expect(html).toContain('data-slot="waiting-dots"');
      expect(html.match(/class="waiting-dot /g)).toHaveLength(3);
      expect(html).toContain("[animation-delay:0.2s]");
      expect(html).toContain("[animation-delay:0.4s]");
      // No clock while it runs, in any form.
      expect(html).not.toMatch(/\d+\s?s</);
      expect(html).not.toContain("coach-turn-steps-seconds");
      expect(html).not.toContain("tabular-nums");
    }
  });

  it("reads brain, text, chevron, in the answer's text size and the muted tone", () => {
    const html = render(
      <CoachTurnActivity
        activity={[THINKING_DONE, FETCH_BP, DIGEST_RUNNING]}
        steps={[BP]}
        active
      />,
    );
    const row = rowHtml(html);
    expect(row.startsWith("<button")).toBe(true);
    const order = [
      row.indexOf("lucide-brain"),
      row.indexOf('data-slot="coach-turn-steps-active"'),
      row.indexOf('data-slot="coach-turn-steps-chevron"'),
    ];
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(row).toContain("lucide-chevron-down");
    expect(row).toMatch(/class="[^"]*\bw-fit\b/);
    expect(row).toMatch(/class="[^"]*\btext-muted-foreground\b/);
    expect(row).toMatch(/class="[^"]*\bhover:text-foreground\b/);
    expect(row).toContain("focus-visible:ring-input-focus");
    expect(row).not.toMatch(/ring-ring|ring-primary|text-primary/);
    expect(html).toMatch(
      /data-slot="coach-turn-steps"[^>]*class="[^"]*\btext-sm\b/,
    );
    expect(html).not.toMatch(
      /data-slot="coach-turn-steps"[^>]*class="[^"]*\btext-xs\b/,
    );
    // A stable name while the text keeps changing.
    expect(row).toContain('aria-label="Show what the Coach looked at"');
    expect(row).toContain('aria-expanded="false"');
  });

  it("says Thinking… before the first frame, with no chevron and nothing to open", () => {
    const html = render(<CoachTurnActivity activity={[]} steps={[]} active />);
    expect(html).toContain('data-text="Thinking…"');
    expect(html).toContain("text-shimmer");
    expect(html).not.toContain("coach-turn-steps-chevron");
    expect(html).not.toContain("aria-expanded");
    expect(rowHtml(html).startsWith("<div")).toBe(true);
  });

  it("names a reasoning title as still going, and a step-only server's step", () => {
    expect(
      render(
        <CoachTurnActivity
          activity={[{ ...THINKING_RUNNING, title: "Checking the trend" }]}
          steps={[]}
          active
        />,
      ),
    ).toContain('data-text="Checking the trend…"');
    expect(
      render(
        <CoachTurnActivity activity={[]} steps={[BP, LABS_RUNNING]} active />,
      ),
    ).toContain('data-text="Checking: Lab results, last 12 months…"');
  });

  it("reads in German", () => {
    const html = render(
      <CoachTurnActivity activity={[]} steps={[]} active />,
      "de",
    );
    expect(html).toContain('data-text="Denkt nach…"');
  });
});

describe("the labels", () => {
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

  it("ends a running line in exactly one ellipsis", () => {
    expect(inProgressLabel("Writing the answer")).toBe("Writing the answer…");
    expect(inProgressLabel("Writing the answer…")).toBe("Writing the answer…");
    expect(inProgressLabel("Writing the answer...")).toBe(
      "Writing the answer…",
    );
  });

  it("picks an icon by the kind of work", () => {
    expect(stepIcon("thinking", undefined)).toBe(Lightbulb);
    expect(stepIcon("fetch", "get_metric_series")).toBe(Database);
    expect(stepIcon("fetch", "get_metric_table")).toBe(Table2);
    expect(stepIcon("fetch", "get_correlations")).toBe(ChartScatter);
    expect(stepIcon(null, "get_sleep")).toBe(Database);
    // The brain belongs to the row, never to a step.
    for (const phase of [
      "thinking",
      "memory",
      "fetch",
      "digest",
      "checkpoint",
      "remember",
      "plan",
      "asking",
      "stop",
      "answer",
    ] as const) {
      expect(stepIcon(phase, undefined)).not.toBe(Brain);
    }
  });
});

describe("after the answer", () => {
  it("settles into the thought process and its step count, without shimmer", () => {
    const html = render(
      <CoachTurnActivity
        activity={SETTLED}
        steps={[BP, SLEEP]}
        active={false}
      />,
    );
    expect(html).toContain('data-state="done"');
    expect(html).toMatch(
      /data-slot="coach-turn-steps-done"[^>]*>Thought process · 5 steps</,
    );
    expect(html).not.toContain("text-shimmer");
    expect(html).not.toContain("waiting-dot");
    expect(html).toContain('data-slot="coach-turn-steps-chevron"');
    expect(html).not.toMatch(/\d+\s?s</);
    // The settled row names itself by its text.
    expect(html).not.toContain('aria-label="Show what the Coach looked at"');
  });

  it("counts in the reader's language, with proper plurals", () => {
    const de = render(
      <CoachTurnActivity activity={[ANSWER_DONE]} steps={[]} active={false} />,
      "de",
    );
    expect(de).toContain("Denkprozess · 1 Schritt<");
    const pl = render(
      <CoachTurnActivity
        activity={[THINKING_DONE, FETCH_BP, ANSWER_DONE]}
        steps={[]}
        active={false}
      />,
      "pl",
    );
    expect(pl).toContain("Tok myślenia · 3 kroki<");
  });

  it("an older message counts its steps, or the areas it drew on", () => {
    expect(
      render(
        <CoachTurnActivity activity={[]} steps={[BP, SLEEP]} active={false} />,
      ),
    ).toContain("Thought process · 2 steps<");
    expect(
      render(
        <CoachTurnActivity
          activity={[]}
          steps={[]}
          active={false}
          areas={["bp"]}
        />,
      ),
    ).toContain("Thought process · 1 step<");
  });

  it("says an answer is needed while a question waits, without shimmer", () => {
    const html = render(
      <CoachTurnActivity
        activity={[THINKING_DONE, ASKING]}
        steps={[]}
        active={false}
        awaitingAnswer
      />,
    );
    expect(html).toContain('data-state="awaiting"');
    expect(html).toMatch(
      /data-slot="coach-turn-steps-done"[^>]*>Answer needed</,
    );
    expect(html).not.toContain("text-shimmer");
    expect(
      render(
        <CoachTurnActivity
          activity={[THINKING_DONE, ASKING]}
          steps={[]}
          active={false}
          awaitingAnswer
        />,
        "de",
      ),
    ).toContain(">Antwort nötig<");
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
        awaitingAnswer
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
      expect(html).not.toContain('aria-expanded="true"');
      expect(html).not.toContain('rotate-180"');
      expect(html).not.toContain('data-slot="coach-turn-steps-panel"');
      expect(html).not.toContain('data-slot="coach-turn-step-detail"');
      expect(html).not.toContain("The second half of the month runs higher.");
    });
  }

  it("a row opened while the turn ran closes when it ends, and nothing opens it", () => {
    // Opened during the run, the turn ends: closed.
    expect(openAfter({ open: true, wasActive: true, active: false })).toBe(
      false,
    );
    // Closed stays closed through every move.
    for (const [wasActive, active] of [
      [true, false],
      [false, true],
      [true, true],
      [false, false],
    ] as const) {
      expect(openAfter({ open: false, wasActive, active })).toBe(false);
    }
    // A tap on a settled row is the person's, and stays.
    expect(openAfter({ open: true, wasActive: false, active: false })).toBe(
      true,
    );
  });
});

describe("tokens and motion", () => {
  it("uses theme tokens only, and every motion is guarded or turned off by reduced motion", () => {
    const html = render(
      <CoachTurnActivity
        activity={[THINKING_DONE, FETCH_BP, DIGEST_RUNNING]}
        steps={[BP]}
        active
      />,
    );
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|dracula-|\[#|oklch\(/i);
    expect(html).not.toMatch(/text-muted-foreground\/\d/);
    const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) =>
      m[1].split(/\s+/),
    );
    for (const cls of classes) {
      if (cls.startsWith("transition") || cls.startsWith("animate-")) {
        throw new Error(`unguarded motion: ${cls}`);
      }
    }
    // A 44 px tap target on phones.
    expect(html).toContain("min-h-11");
  });

  it("the shimmer and the dots stop under reduced motion, in the stylesheet", () => {
    const css = readFileSync(
      join(__dirname, "../../../../app/globals.css"),
      "utf8",
    );
    const shimmer =
      css.match(/@utility text-shimmer \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(shimmer).toContain("background-clip: text");
    expect(shimmer).toContain("background-size: 250% 100%");
    expect(shimmer).toContain("animation: text-shimmer 2s linear infinite");
    expect(shimmer).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*animation: none;\s*background-image: none;\s*color: var\(--muted-foreground\);/,
    );
    expect(css).toMatch(
      /@keyframes text-shimmer \{\s*from \{\s*background-position: 100% 0;\s*\}\s*to \{\s*background-position: 0% 0;/,
    );
    const dot = css.match(/@utility waiting-dot \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(dot).toContain("animation: waiting-dot 1.4s ease-in-out infinite");
    expect(dot).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*animation: none;\s*opacity: 1;/,
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

describe("the visible row text", () => {
  it("is the status alone", () => {
    expect(
      textOf(
        rowHtml(
          render(
            <CoachTurnActivity activity={SETTLED} steps={[]} active={false} />,
          ),
        ),
      ),
    ).toBe("Thought process · 5 steps");
    expect(
      textOf(
        rowHtml(render(<CoachTurnActivity activity={[]} steps={[]} active />)),
      ),
    ).toBe("Thinking...");
  });
});
