import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { pluralKey } from "@/lib/i18n/plural";
import type { Locale } from "@/lib/i18n/config";
import type { CoachStep } from "@/lib/ai/coach/types";

import {
  CoachTurnStepList,
  CoachTurnSteps,
  CoachTurnStepsPanel,
  countSources,
  legacyAreaLabels,
  currentStep,
  describeStep,
  nextAnnouncement,
  stepLabel,
} from "../turn-steps";

function render(node: React.ReactNode, locale: Locale = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
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

describe("currentStep / nextAnnouncement", () => {
  it("names the latest running step, else the latest step", () => {
    expect(currentStep([BP, LABS_RUNNING, SLEEP])?.id).toBe("s3");
    expect(currentStep([BP, SLEEP])?.id).toBe("s2");
    expect(currentStep([])).toBeNull();
  });

  it("announces only settled steps not yet told, the newest one", () => {
    expect(nextAnnouncement([BP, SLEEP, LABS_RUNNING], new Set())?.id).toBe(
      "s2",
    );
    expect(nextAnnouncement([BP, SLEEP], new Set(["s1", "s2"]))).toBeNull();
    expect(nextAnnouncement([LABS_RUNNING], new Set())).toBeNull();
  });
});

describe("<CoachTurnSteps>", () => {
  it("renders nothing without steps", () => {
    expect(render(<CoachTurnSteps steps={[]} active />)).not.toContain(
      "coach-turn-steps",
    );
  });

  it("while active: the running step in the header, with a stable accessible name", () => {
    const html = render(<CoachTurnSteps steps={[BP, LABS_RUNNING]} active />);
    expect(html).toContain('data-slot="coach-turn-steps-active"');
    expect(html).toContain("Checking: Lab results, last 12 months…");
    expect(html).toContain('aria-label="Show what the Coach looked at"');
    expect(html).toContain('aria-expanded="false"');
    // The shimmer comes from the class that stops under reduced motion.
    expect(html).toContain("skeleton-shimmer");
    // Collapsed by default.
    expect(html).not.toContain('data-slot="coach-turn-steps-list"');
  });

  it("when done: folds into a count of sources, closed", () => {
    const html = render(<CoachTurnSteps steps={[BP, SLEEP]} active={false} />);
    expect(html).toContain("Looked at 2 sources");
    expect(html).not.toContain("skeleton-shimmer");
    expect(html).not.toContain("aria-label=");
    expect(html).not.toContain('data-slot="coach-turn-steps-list"');
  });

  it("counts distinct sources: a second read of the same domain is not a new source", () => {
    const bpPrevious: CoachStep = {
      ...BP,
      id: "s4",
      period: "previous",
      count: 120,
    };
    const snapshot: CoachStep = {
      id: "s5",
      tool: "snapshot",
      labelKey: "coach.step.snapshot",
      label: "Overview",
      status: "done",
    };
    expect(countSources([BP, bpPrevious, SLEEP])).toBe(2);
    expect(countSources([BP, snapshot, snapshot])).toBe(2);
    const html = render(
      <CoachTurnSteps steps={[BP, bpPrevious, SLEEP]} active={false} />,
    );
    expect(html).toContain("Looked at 2 sources");
  });

  it("carries a polite status region that starts empty", () => {
    const html = render(<CoachTurnSteps steps={[BP]} active={false} />);
    expect(html).toMatch(
      /<span role="status" aria-live="polite" aria-atomic="true" class="sr-only"><\/span>/,
    );
  });

  it("uses theme tokens only, and every motion stops under reduced motion", () => {
    const html =
      render(<CoachTurnSteps steps={[BP, LABS_RUNNING]} active />) +
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
    // The spinner stops under reduced motion (the repo-wide convention).
    expect(html).toContain("animate-spin motion-reduce:animate-none");
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
    let text = html.replace(/<span class="sr-only">, <\/span>/g, "");
    // Strip tags until nothing changes, so no fragment can survive one pass.
    for (let prev = ""; prev !== text;) {
      prev = text;
      text = text.replace(/<[^>]*>/g, "");
    }
    expect(text).toContain("Blood pressure · last 90 days · 142 readings");
    expect(text).toContain("Sleep · last 30 days · no readings");
    expect(text).toContain("Lab results · last 12 months");
  });

  it("a reloaded list shows the same rows", () => {
    const live = render(<CoachTurnStepList steps={[BP, SLEEP]} active />);
    const stored = render(
      <CoachTurnStepList
        steps={JSON.parse(JSON.stringify([BP, SLEEP]))}
        active={false}
      />,
    );
    const text = (h: string) => h.replace(/<svg[\s\S]*?<\/svg>/g, "");
    expect(text(stored)).toBe(text(live));
  });
});

describe("the open list: method and the tables the answer read", () => {
  const METHOD = {
    entries: [],
    text: "Blood pressure, last 30 days, 9 readings, daily averages.",
  };

  it("ends with the method line and the data-used slot, after the steps", () => {
    const html = render(
      <CoachTurnStepsPanel
        steps={[BP]}
        active={false}
        areaLabels={[]}
        method={METHOD}
        dataUsed={<div data-slot="coach-data-used">tables</div>}
      />,
    );
    const steps = html.indexOf('data-slot="coach-turn-steps-list"');
    const method = html.indexOf('data-slot="coach-method-line"');
    const dataUsed = html.indexOf('data-slot="coach-data-used"');
    expect(steps).toBeGreaterThan(-1);
    expect(method).toBeGreaterThan(steps);
    expect(dataUsed).toBeGreaterThan(method);
    expect(html).toContain(METHOD.text);
  });

  it("holds the method back while the turn runs", () => {
    const html = render(
      <CoachTurnStepsPanel
        steps={[LABS_RUNNING]}
        active
        areaLabels={[]}
        method={METHOD}
        dataUsed={<div data-slot="coach-data-used" />}
      />,
    );
    expect(html).not.toContain("coach-method-line");
    expect(html).not.toContain("coach-data-used");
  });

  it("lists an older message's areas, without counts", () => {
    const html = render(
      <CoachTurnStepsPanel
        steps={[]}
        active={false}
        areaLabels={["Blood pressure", "Sleep"]}
      />,
    );
    expect(html).toContain('data-slot="coach-turn-areas"');
    expect((html.match(/data-slot="coach-turn-area"/g) ?? []).length).toBe(2);
    expect(html).not.toMatch(/\d+ readings/);
  });

  it("shows a header for an answer that has only a method", () => {
    const html = render(
      <CoachTurnSteps steps={[]} active={false} method={METHOD} />,
    );
    expect(html).toContain("What the Coach looked at");
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

  it("folds an older message into a count of areas", () => {
    const html = render(
      <CoachTurnSteps steps={[]} active={false} areas={["bp", "sleep"]} />,
    );
    expect(html).toContain("Looked at 2 areas");
    expect(
      render(<CoachTurnSteps steps={[]} active={false} areas={["bp"]} />, "de"),
    ).toContain("1 Bereich angesehen");
  });
});
