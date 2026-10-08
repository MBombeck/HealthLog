import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, useTranslations } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import type {
  HealthScoreReport,
  ScorePillarResult,
} from "@/lib/analytics/score/types";
import { SCORE_VERSION } from "@/lib/analytics/score/types";
import {
  HealthScoreCard,
  HealthScoreCardSkeleton,
  markAlgorithmNoticeDismissed,
  markCompositionNoticeDismissed,
} from "../health-score-card";
import {
  pillarDetailLines,
  pillarObservedText,
  type Translate,
} from "../health-score-pillar-detail";

let mockAuthUser: {
  unitPreference: string;
  glucoseUnit: string;
  timezone?: string;
} = {
  unitPreference: "metric",
  glucoseUnit: "mg/dL",
};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mockAuthUser,
  }),
}));

const provenance = {
  inputs: ["BLOOD_PRESSURE"],
  source: "live" as const,
  windowDays: 90,
  computedAt: "2026-07-28T12:00:00.000Z",
};
const coverage = {
  requiredInputs: 3,
  presentInputs: 1,
  historyDays: 7,
  missing: ["ACTIVITY", "SLEEP"],
};

function render(node: React.ReactNode, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

/**
 * The pillar detail lines live behind a Radix popover, which only mounts its
 * body once opened, so they are asserted through the pure formatter the card
 * feeds the popover. Lifting the live translator out of a throwaway render
 * keeps those assertions on the SAME strings the card shows rather than a
 * second copy of the copy.
 */
function translator(locale: Locale = "en"): Translate {
  let captured: Translate | null = null;
  function Probe() {
    captured = useTranslations().t;
    return null;
  }
  renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <Probe />
    </I18nProvider>,
  );
  if (!captured) throw new Error("translator probe did not run");
  return captured;
}

const BLOOD_PRESSURE: ScorePillarResult = {
  id: "BLOOD_PRESSURE",
  domain: "cardiometabolic",
  result: {
    status: "ok",
    value: {
      score: 82,
      observed: {
        value: 126,
        unit: "mmHg",
        label: "126/78 mmHg",
        asOf: "2026-07-27T08:00:00.000Z",
        sources: ["MANUAL"],
      },
      reference: {
        kind: "clinical-threshold",
        low: 120,
        high: 129,
        label: "120 to 129/70 to 79 mmHg",
        source: "ESH 2023",
      },
      personalReference: {
        kind: "guideline-band",
        low: 115,
        high: 125,
        label: "115 to 125/65 to 75 mmHg",
        source: "personal target",
      },
      noiseFloor: 1,
      deltaEligible: true,
      deltaIdentity: "graded_bp_pair_series",
    },
    coverage: {
      requiredInputs: 12,
      presentInputs: 12,
      historyDays: 28,
      missing: [],
    },
    confidence: { score: 100, band: "high" },
    provenance,
  },
};

const ACTIVITY_BELOW_FLOOR: ScorePillarResult = {
  id: "ACTIVITY",
  domain: "activity",
  result: {
    status: "insufficient",
    coverage: {
      requiredInputs: 21,
      presentInputs: 7,
      historyDays: 7,
      missing: ["14 days"],
    },
    provenance: { ...provenance, inputs: ["ACTIVITY"], windowDays: 28 },
    reason: "below_day_floor_or_stale",
  },
};

const FASTING_GLUCOSE: ScorePillarResult = {
  id: "GLYCAEMIA",
  domain: "cardiometabolic",
  result: {
    status: "ok",
    value: {
      score: 80,
      observed: {
        value: 100,
        unit: "mg/dL",
        label: "Fasting glucose",
        asOf: "2026-07-27T08:00:00.000Z",
        sources: ["MANUAL"],
      },
      reference: {
        kind: "clinical-threshold",
        low: 70,
        high: 99,
        label: "70 to 99 mg/dL fasting",
        source: "ADA 2026",
      },
      noiseFloor: 1,
      deltaEligible: true,
      deltaIdentity: "fasting_glucose",
    },
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 1,
      missing: [],
    },
    confidence: { score: 100, band: "high" },
    provenance,
  },
};

/** A scored pillar at an arbitrary score, for the partition + tint tests. */
function scoredAt(
  id: ScorePillarResult["id"],
  score: number,
): ScorePillarResult {
  const base = BLOOD_PRESSURE.result;
  if (base.status !== "ok") throw new Error("fixture is not scored");
  return {
    ...BLOOD_PRESSURE,
    id,
    result: { ...base, value: { ...base.value, score } },
  };
}

function gatedPillar(
  id: ScorePillarResult["id"],
  reason: string,
): ScorePillarResult {
  return {
    id,
    domain: "wellbeing",
    result: {
      status: "insufficient",
      coverage: {
        requiredInputs: 1,
        presentInputs: 0,
        historyDays: 0,
        missing: [],
      },
      provenance: { ...provenance, inputs: [id] },
      reason,
    },
  };
}

function report(overrides: Partial<HealthScoreReport> = {}): HealthScoreReport {
  return {
    composite: {
      status: "insufficient",
      coverage,
      provenance,
      reason: "no_usable_data",
    },
    pillars: [BLOOD_PRESSURE, ACTIVITY_BELOW_FLOOR],
    delta: null,
    deltaReason: "no_current_score",
    scoreVersion: SCORE_VERSION,
    weightGoal: {
      status: "insufficient",
      coverage: {
        requiredInputs: 2,
        presentInputs: 0,
        historyDays: 0,
        missing: ["weight reading", "personal weight target"],
      },
      provenance: { ...provenance, inputs: ["WEIGHT"] },
      reason: "no_personal_goal",
    },
    algorithmNotice: null,
    ...overrides,
  };
}

function scoredReport(
  overrides: Partial<HealthScoreReport> = {},
): HealthScoreReport {
  return report({
    composite: {
      status: "ok",
      value: {
        score: 86,
        band: "green",
        bandSetter: null,
        composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
        configured: false,
        noiseFloor: 3,
        scoreVersion: SCORE_VERSION,
      },
      coverage: {
        requiredInputs: 3,
        presentInputs: 3,
        historyDays: 28,
        missing: [],
      },
      confidence: { score: 100, band: "high" },
      provenance: {
        ...provenance,
        inputs: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      },
    },
    delta: 2,
    deltaReason: null,
    ...overrides,
  });
}

/** The markup between the disclosure region's open tag and the card's end. */
function anatomyRegion(html: string): string {
  const start = html.indexOf('data-slot="health-score-anatomy-region"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start);
}

/** Everything visible without opening the disclosure. */
function atRest(html: string): string {
  const end = html.indexOf('data-slot="health-score-anatomy-region"');
  expect(end).toBeGreaterThan(-1);
  return html.slice(0, end);
}

/** The named not-scored list itself, not merely the region containing it. */
function notScoredList(html: string): string {
  const start = html.indexOf('data-slot="health-score-not-scored"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</ul>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

/** Every `data-pillar="X"` in document order — the plural attribute never matches. */
function pillarAttrs(html: string): string[] {
  return [...html.matchAll(/data-pillar="([^"]+)"/g)].map((m) => m[1]);
}

/** The ids a coalesced line declares it speaks for. */
function pillarsAttr(html: string, slot: string): string[] {
  const m = html.match(
    new RegExp(`data-slot="${slot}"\\s+data-pillars="([^"]*)"`),
  );
  return m && m[1] ? m[1].split(",") : [];
}

beforeEach(() => {
  mockAuthUser = { unitPreference: "metric", glucoseUnit: "mg/dL" };
});

describe("<HealthScoreCard> disclosure", () => {
  it("opens collapsed: the breakdown is present but hidden and out of tab order", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    expect(html).toMatch(
      /aria-expanded="false"[^>]*data-slot="health-score-anatomy-toggle"/,
    );
    // The trigger points at the region it controls, and the region is `hidden`
    // rather than unmounted, so opening it is a paint, not a fetch.
    const controls = html.match(/aria-controls="([^"]+)"/);
    expect(controls).not.toBeNull();
    expect(html).toContain(`id="${controls![1]}" hidden=""`);
    expect(anatomyRegion(html)).toContain('data-slot="health-score-method"');
  });

  it("keeps the number and the contributor rows out of the disclosure", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    const rest = atRest(html);
    // The number, the bar, the band sentence and the delta are the panel's
    // face; the rows sit directly under them, not behind a toggle.
    expect(rest).toContain('data-slot="health-score-card-number"');
    expect(rest).toContain('data-slot="health-score-card-progress"');
    expect(rest).toContain('data-slot="health-score-band"');
    expect(rest).toContain('data-slot="health-score-delta"');
    expect(rest).toContain(">86<");
    expect(rest).toContain('data-slot="health-score-pillars"');
    // The named reasons, the weight goal and the method footer are what the
    // disclosure is for.
    expect(rest).not.toContain('data-slot="health-score-method"');
    expect(rest).not.toContain('data-slot="health-score-weight-goal"');
    expect(rest).not.toContain('data-slot="health-score-not-scored"');
  });

  it("wears the hero column's width and stretches to the band", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    // The panel owns its own column geometry, so the band's `items-stretch`
    // can equalise it against the greeting.
    expect(html).toContain("md:basis-[22rem]");
    expect(html).toContain("xl:basis-[26rem]");
    expect(html).toContain("md:shrink-0");
    expect(html).toContain("flex h-full flex-col");
  });
});

describe("<HealthScoreCard> pillars", () => {
  it("gives a row to the scored pillars only, never to a gated one", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    const rest = atRest(html);
    expect(rest).toContain('data-pillar="BLOOD_PRESSURE" data-status="ok"');
    expect(rest).not.toContain('data-pillar="ACTIVITY" data-status="ok"');
    // One line per row: a truncating label column, a thin bar, the score.
    expect(rest).toContain("grid-cols-[minmax(0,7rem)_1fr_2rem_auto]");
    expect(rest).toContain("width:82%");
  });

  it("tints each row with its OWN band, not the composite's", () => {
    // The composite is red and the two pillars sit either side of the green
    // threshold. The old rows took the composite's colour and painted the
    // strong pillar red.
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          composite: {
            status: "ok",
            value: {
              score: 31,
              band: "red",
              bandSetter: null,
              composition: ["BLOOD_PRESSURE", "GLYCAEMIA"],
              configured: false,
              noiseFloor: 3,
              scoreVersion: SCORE_VERSION,
            },
            coverage: {
              requiredInputs: 3,
              presentInputs: 3,
              historyDays: 28,
              missing: [],
            },
            confidence: { score: 100, band: "high" },
            provenance,
          },
          pillars: [
            scoredAt("BLOOD_PRESSURE", 92),
            scoredAt("GLYCAEMIA", 22),
            scoredAt("SLEEP", 55),
          ],
        })}
      />,
    );
    const rows = atRest(html).split('data-pillar="');
    const barClass = (id: string) => {
      const row = rows.find((r) => r.startsWith(id));
      expect(row, `${id} has no row`).toBeDefined();
      const m = row!.match(
        /data-slot="health-score-pillar-bar" class="([^"]*)"/,
      );
      expect(m, `${id} has no bar`).not.toBeNull();
      return m![1];
    };
    expect(barClass("BLOOD_PRESSURE")).toContain("bg-success");
    expect(barClass("GLYCAEMIA")).toContain("bg-destructive");
    expect(barClass("SLEEP")).toContain("bg-warning");
    // The composite is red, so a composite-tinted set would be all-red.
    expect(barClass("BLOOD_PRESSURE")).not.toContain("bg-destructive");
  });

  it("counts absence at rest and names it behind the disclosure", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    // At rest: a count, never a name drawn as a zero.
    expect(atRest(html)).toContain("Not scored yet (1)");
    expect(atRest(html)).toContain('data-count="1"');
    const region = anatomyRegion(html);
    expect(region).toContain('data-slot="health-score-not-scored"');
    expect(region).toContain('data-reason="below_day_floor_or_stale"');
    expect(region).toContain("Not enough recent eligible data");
    expect(region).not.toContain("below_day_floor_or_stale<");
  });

  it("treats a failed read as an error with a retry, never as absence", () => {
    const retry = vi.fn();
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          pillars: [
            BLOOD_PRESSURE,
            gatedPillar("SLEEP", "read_failed"),
            ACTIVITY_BELOW_FLOOR,
          ],
        })}
        onRetry={retry}
      />,
    );
    // A failure may be quiet, but it may not hide: the line and its retry are
    // visible without opening anything.
    const rest = atRest(html);
    expect(rest).toContain('data-slot="health-score-pillar-error"');
    expect(rest).toContain('role="alert"');
    expect(rest).toContain('data-slot="health-score-pillar-retry"');
    expect(rest).toContain("Data could not be loaded");
    expect(rest).toContain("Not scored yet (1)");

    // A failed read is NOT absence, so it stays out of the "not scored" list.
    const region = anatomyRegion(html);
    expect(region).not.toContain('data-reason="read_failed"');
    expect(notScoredList(html)).not.toContain('data-reason="read_failed"');
    expect(notScoredList(html)).not.toContain('data-pillar="SLEEP"');
  });

  it("coalesces every failed read into one line with one retry", () => {
    // Lipids and HbA1c come off one labs read, so a single failure gates two
    // pillars. One cause, one line, one retry — and the retry refetches the
    // whole payload anyway.
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          pillars: [
            BLOOD_PRESSURE,
            gatedPillar("LIPIDS", "read_failed"),
            gatedPillar("GLYCAEMIA", "read_failed"),
          ],
        })}
        onRetry={vi.fn()}
      />,
    );
    expect(
      html.match(/data-slot="health-score-pillar-error"/g) ?? [],
    ).toHaveLength(1);
    expect(
      html.match(/data-slot="health-score-pillar-retry"/g) ?? [],
    ).toHaveLength(1);
    expect(pillarsAttr(html, "health-score-pillar-error")).toEqual([
      "LIPIDS",
      "GLYCAEMIA",
    ]);
    expect(atRest(html)).toContain("Lipids, Glycaemia: Data could not be");
  });

  it("names safety signposting at rest instead of counting it", () => {
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          pillars: [
            BLOOD_PRESSURE,
            ACTIVITY_BELOW_FLOOR,
            gatedPillar("WELLBEING", "crisis_signposting"),
          ],
        })}
      />,
    );
    // Safety copy is content: it is named in full on the surface, not folded
    // into a count and not hidden behind the toggle.
    const rest = atRest(html);
    expect(rest).toContain('data-slot="health-score-crisis"');
    expect(rest).toContain("Wellbeing: Safety guidance is shown instead of");
    // …and therefore it is not also one of the anonymous counted absences.
    expect(rest).toContain("Not scored yet (1)");
    expect(rest).toContain('data-count="1"');
    expect(anatomyRegion(html)).not.toContain(
      'data-reason="crisis_signposting"',
    );
  });
});

describe("<HealthScoreCard> one pillar, one home", () => {
  /** Four scored, one failed read, one crisis, one plain absence. */
  function mixedReport() {
    return scoredReport({
      pillars: [
        scoredAt("BLOOD_PRESSURE", 82),
        scoredAt("GLYCAEMIA", 74),
        scoredAt("ACTIVITY", 61),
        scoredAt("SLEEP", 45),
        gatedPillar("LIPIDS", "read_failed"),
        gatedPillar("WELLBEING", "crisis_signposting"),
        gatedPillar("ADIPOSITY", "missing_height"),
      ],
    });
  }

  it("puts every pillar in exactly one of the four homes", () => {
    const html = render(<HealthScoreCard report={mixedReport()} />);
    const rest = atRest(html);

    const rowIds = [
      ...rest.matchAll(/data-pillar="([^"]+)" data-status="ok"/g),
    ].map((m) => m[1]);
    const failedIds = pillarsAttr(html, "health-score-pillar-error");
    const crisisIds = pillarsAttr(html, "health-score-crisis");
    const counted = Number(rest.match(/data-count="(\d+)"/)?.[1] ?? 0);

    expect(rowIds).toEqual([
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "ACTIVITY",
      "SLEEP",
    ]);
    expect(failedIds).toEqual(["LIPIDS"]);
    expect(crisisIds).toEqual(["WELLBEING"]);
    expect(counted).toBe(1);

    // The four homes partition the seven pillars: disjoint, and complete.
    const named = [...rowIds, ...failedIds, ...crisisIds];
    expect(new Set(named).size).toBe(named.length);
    expect(named.length + counted).toBe(7);
  });

  it("never renders one pillar id twice anywhere in the panel", () => {
    const html = render(<HealthScoreCard report={mixedReport()} />);
    // The scored rows and the named not-scored list both carry `data-pillar`;
    // the coalesced lines carry the plural `data-pillars` and are not matched
    // here. Seeing an id twice is exactly the complaint this panel answers.
    const ids = pillarAttrs(html);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      ["ACTIVITY", "ADIPOSITY", "BLOOD_PRESSURE", "GLYCAEMIA", "SLEEP"].sort(),
    );
  });

  it("never renders one pillar's name twice anywhere in the panel", () => {
    const html = render(<HealthScoreCard report={mixedReport()} />);
    // The method footer's "Overall band set by …" sentence names a pillar as
    // prose rather than listing it, so it is not part of this count.
    const methodAt = html.indexOf('data-slot="health-score-method"');
    expect(methodAt).toBeGreaterThan(-1);
    const listed = html.slice(0, methodAt);
    for (const label of [
      "Blood pressure",
      "Glycaemia",
      "Activity",
      "Sleep",
      "Adiposity",
      "Wellbeing",
      "Lipids",
    ]) {
      const hits = listed.split(label).length - 1;
      expect(hits, `${label} appears ${hits} times`).toBeLessThanOrEqual(1);
    }
  });
});

describe("<HealthScoreCard> composite states", () => {
  it("shows a dash and the learning line when the composite is gated", () => {
    const html = render(<HealthScoreCard report={report()} />);
    expect(html).toMatch(
      /data-slot="health-score-card"[^>]*data-status="insufficient"/,
    );
    expect(html).toContain('data-slot="health-score-insufficient"');
    // The gate survives exactly one case since v1.38: nothing readable at
    // all. It no longer names a breadth the score "needs" — there is none,
    // one area is enough — and it no longer counts areas, because above
    // zero there is a score instead of a gate.
    expect(html).toContain(
      "Nothing has enough recent data to score yet. One area of health is enough to start, and the score will say which areas it rests on.",
    );
    expect(html).not.toMatch(/eligible pillars/i);
    expect(html).not.toMatch(/the score needs/i);
    // The gate is the refusal's own face and nothing else wears it: a
    // narrow score gets the basis line, a different sentence in a
    // different slot.
    expect(html).not.toContain('data-slot="health-score-basis"');
    // No band sentence and no fabricated number: a dash, and no bar either.
    expect(html).not.toContain('data-slot="health-score-band"');
    expect(html).not.toContain('data-slot="health-score-card-progress"');
    expect(html).toContain("—");
    expect(html).not.toContain("/ 100");
    expect(html).toContain(`Method version ${SCORE_VERSION}`);
  });

  it("explains a missing comparison where the trend would be", () => {
    const html = render(<HealthScoreCard report={report()} />);
    expect(html).toContain('data-slot="health-score-delta-reason"');
    expect(html).toContain(
      "No comparison because the current window is not eligible.",
    );
    expect(html).not.toContain('data-slot="health-score-delta"');
  });

  it("annotates the number with Rest Mode and the ambient context lines", () => {
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          restMode: {
            active: true,
            since: "2026-07-19T23:30:00.000Z",
            episodeCount: 1,
          },
        })}
        tension={{ band: "yellow", positive: ["sleep"], negative: ["rhr"] }}
        returnToBand={{ metricType: "RESTING_HEART_RATE", daysInside: 6 }}
      />,
    );
    const rest = atRest(html);
    // The onset is an instant; it reads as the day it falls on in the
    // profile timezone, in the user's date format, never as raw ISO.
    // v1.42 — the date is a link to its day; the sentence reads the same.
    expect(rest.replace(/<[^>]+>/g, "")).toMatch(
      /Rest Mode active since \d{2}\/\d{2}\/2026\./,
    );
    expect(rest).not.toContain("T23:30:00");
    expect(rest).toContain('data-slot="health-score-tension"');
    expect(rest).toContain('data-slot="health-score-return-to-band"');
    // The contributor key and the metric type are localised, never raw.
    expect(rest).toContain("Resting heart rate");
    expect(rest).not.toContain("RESTING_HEART_RATE");
    expect(rest).not.toContain(">rhr<");
  });

  it("reads the Rest Mode onset as the day in the profile timezone", () => {
    mockAuthUser = {
      unitPreference: "metric",
      glucoseUnit: "mg/dL",
      timezone: "Europe/Berlin",
    };
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          restMode: {
            active: true,
            since: "2026-07-19T23:30:00.000Z",
            episodeCount: 1,
          },
        })}
      />,
    );
    const rest = atRest(html);
    expect(rest.replace(/<[^>]+>/g, "")).toMatch(
      /Rest Mode active since (07\/20\/2026|20\/07\/2026)/,
    );
    // The date opens the day it names, in the profile timezone.
    expect(rest).toContain('data-day="2026-07-20"');
    expect(rest).not.toContain("2026-07-19T");
  });

  it("shows the weekly gain as a chip beside the label", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    expect(html).toContain('data-slot="health-score-card-label"');
    expect(html).toContain('data-slot="health-score-card-delta-chip"');
    expect(html).toMatch(/data-slot="health-score-card-delta-chip"[^>]*>\+2</);
  });

  it("keeps the chip away from a flat or falling week", () => {
    const html = render(
      <HealthScoreCard report={scoredReport({ delta: -3 })} />,
    );
    expect(html).not.toContain('data-slot="health-score-card-delta-chip"');
    // The line still states it — only the green chip is reserved for a gain.
    expect(html).toContain('data-slot="health-score-delta"');
  });

  it("keeps a one-sided tension quiet", () => {
    const html = render(
      <HealthScoreCard
        report={scoredReport()}
        tension={{ band: "yellow", positive: ["sleep"], negative: [] }}
      />,
    );
    expect(html).not.toContain('data-slot="health-score-tension"');
  });
});

describe("<HealthScoreCard> footer", () => {
  it("carries the band setter, the version and the cited method", () => {
    const html = render(<HealthScoreCard report={scoredReport()} />);
    const region = anatomyRegion(html);
    expect(region).toContain('data-slot="health-score-method"');
    expect(region).toContain("Overall band set by none");
    expect(region).toContain(
      `Method version ${SCORE_VERSION}. Weekly comparison floor`,
    );
    expect(region).toContain('data-slot="provenance-explainer-method"');
    expect(region).toContain("equal-weighted average");
  });

  it("states an authored composition in the method footer, and only when the server says so", () => {
    // The footer reads the resolved flag off the composite and says one
    // sentence. It never names the pillars the person took out — that is
    // the settings surface's job — and it never appears for an account
    // whose composition is the default one.
    const configured = render(
      <HealthScoreCard
        report={scoredReport({
          composite: {
            ...(scoredReport().composite as Extract<
              HealthScoreReport["composite"],
              { status: "ok" }
            >),
            value: {
              ...(
                scoredReport().composite as Extract<
                  HealthScoreReport["composite"],
                  { status: "ok" }
                >
              ).value,
              configured: true,
            },
          },
        })}
      />,
    );
    expect(anatomyRegion(configured)).toContain(
      'data-slot="health-score-configured"',
    );
    expect(anatomyRegion(configured)).toContain(
      "You chose which pillars count toward this score.",
    );

    const inherited = render(<HealthScoreCard report={scoredReport()} />);
    expect(inherited).not.toContain('data-slot="health-score-configured"');
    expect(inherited).not.toContain("You chose which pillars count");
  });

  it("shows the personal weight goal as explicitly unscored context", () => {
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          weightGoal: {
            status: "ok",
            value: {
              currentKg: 81,
              target: { min: 74, max: 78 },
              distanceKg: 3,
              deltaKg: 1,
              asOf: "2026-07-27T08:00:00.000Z",
              source: "MANUAL",
            },
            coverage: {
              requiredInputs: 2,
              presentInputs: 2,
              historyDays: 1,
              missing: [],
            },
            confidence: { score: 100, band: "high" },
            provenance,
          },
        })}
      />,
    );
    const region = anatomyRegion(html);
    expect(region).toContain('data-slot="health-score-weight-goal"');
    // The caption sits on the type scale, never the bespoke 11 px it carried
    // while the goal was a standalone card.
    expect(region).toContain(
      '<p class="text-muted-foreground mt-2 text-xs">Weight-goal progress is personal context and does not affect the Health Score.</p>',
    );
  });

  it("renders the personal weight goal in the account unit system", () => {
    mockAuthUser = { unitPreference: "imperial", glucoseUnit: "mg/dL" };
    const html = render(
      <HealthScoreCard
        report={scoredReport({
          weightGoal: {
            status: "ok",
            value: {
              currentKg: 81,
              target: { min: 74, max: 78 },
              distanceKg: 3,
              deltaKg: 1,
              asOf: "2026-07-27T08:00:00.000Z",
              source: "MANUAL",
            },
            coverage: {
              requiredInputs: 2,
              presentInputs: 2,
              historyDays: 1,
              missing: [],
            },
            confidence: { score: 100, band: "high" },
            provenance,
          },
        })}
      />,
    );
    expect(html).toContain("178.6 lb now");
    expect(html).toContain("Goal 163.1 to 172 lb");
    expect(html).not.toContain("81 kg");
  });
});

describe("pillar detail formatting", () => {
  it("renders the observed line in the account glucose unit", () => {
    const html = render(
      <HealthScoreCard report={scoredReport({ pillars: [FASTING_GLUCOSE] })} />,
    );
    // The observed value moved into the row's popover, which Radix mounts
    // only once opened — so the panel shows the row, and the value itself is
    // asserted through the same pure formatter the popover is fed.
    expect(html).toContain('data-pillar="GLYCAEMIA" data-status="ok"');
    expect(html).toContain('data-slot="info-popover-trigger"');
    expect(
      pillarObservedText(FASTING_GLUCOSE, {
        t: translator(),
        glucoseUnit: "mg/dL",
      }),
    ).toBe("Fasting glucose: 100 mg/dL");

    const mmol = pillarObservedText(FASTING_GLUCOSE, {
      t: translator(),
      glucoseUnit: "mmol/L",
    });
    expect(mmol).toBe("Fasting glucose: 5.5 mmol/L");
  });

  it("converts the reference band behind the popover into the account unit", () => {
    const lines = pillarDetailLines(FASTING_GLUCOSE, {
      t: translator(),
      glucoseUnit: "mmol/L",
    });
    expect(lines.join("\n")).toContain("3.9 to 5.5 mmol/L fasting");
    expect(lines.join("\n")).not.toContain("70 to 99 mg/dL");
  });

  it("keeps the reference, the personal target and the source together", () => {
    const lines = pillarDetailLines(BLOOD_PRESSURE, {
      t: translator(),
      glucoseUnit: "mg/dL",
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("ESH 2023");
    expect(lines[1]).toContain("Your target: 115 to 125/65 to 75 mmHg");
    expect(lines[2]).toContain("Source: MANUAL");
  });

  it("localises the structured activity labels and references", () => {
    const activity: ScorePillarResult = {
      id: "ACTIVITY",
      domain: "activity",
      result: {
        status: "ok",
        value: {
          score: 80,
          observed: {
            value: 8_000,
            unit: "steps/day",
            label: "8,000 steps/day",
            asOf: "2026-07-27T00:00:00.000Z",
            sources: ["APPLE_HEALTH"],
          },
          reference: {
            kind: "guideline-band",
            low: 0,
            high: 10_000,
            label: "benefit plateaus by 10,000 steps/day",
            source: "Paluch 2022",
          },
          noiseFloor: 1,
          deltaEligible: true,
          deltaIdentity: "ACTIVITY_STEPS",
        },
        coverage: {
          requiredInputs: 21,
          presentInputs: 21,
          historyDays: 21,
          missing: [],
        },
        confidence: { score: 100, band: "high" },
        provenance,
      },
    };
    const de = { t: translator("de"), glucoseUnit: "mg/dL" as const };
    expect(pillarObservedText(activity, de)).toContain("Schritte pro Tag");
    const lines = pillarDetailLines(activity, de).join("\n");
    expect(lines).toContain("Der Nutzen flacht");
    expect(lines).toContain("Leitlinienbereich");
    expect(lines).not.toContain("benefit plateaus by");
    expect(lines).not.toContain("guideline-band");
  });
});

describe("<HealthScoreCardSkeleton>", () => {
  it("reserves the column's footprint and announces nothing", () => {
    const html = render(<HealthScoreCardSkeleton />);
    expect(html).toContain('data-slot="health-score-card-skeleton"');
    expect(html).toContain('aria-hidden="true"');
    // A reserve that is not the panel's width is not a reserve.
    expect(html).toContain("md:basis-[22rem]");
    expect(html).toContain("xl:basis-[26rem]");
    // That it declares a floor at all is what this file can honestly check;
    // whether the floor is the RIGHT height is a browser question, and
    // `health-score-card-geometry.test.tsx` answers it by measuring the panel
    // and the reserve side by side. Pinning the literal here would only mean
    // the two places have to be edited together.
    expect(html).toMatch(/min-h-\[[\d.]+rem\]/);
  });

  it("holds the same column geometry the resolved panel does", () => {
    const skeleton = render(<HealthScoreCardSkeleton />);
    const panel = render(<HealthScoreCard report={scoredReport()} />);
    // Any drift between the two is a jump when the payload lands.
    for (const cls of [
      "w-full",
      "md:shrink-0",
      "md:grow-0",
      "md:basis-[22rem]",
      "xl:basis-[26rem]",
      "flex h-full flex-col",
      "rounded-xl border p-4",
      "md:p-6",
    ]) {
      expect(skeleton, cls).toContain(cls);
      expect(panel, cls).toContain(cls);
    }
  });
});

describe("markAlgorithmNoticeDismissed", () => {
  it("patches the cached analytics report after the notice is dismissed", () => {
    const payload = {
      healthScore: report({
        algorithmNotice: {
          itemKey: "health_score_algorithm:2",
          dismissed: false,
        },
      }),
    };
    const patched = markAlgorithmNoticeDismissed(
      payload,
      "health_score_algorithm:2",
    );
    expect(patched).toMatchObject({
      healthScore: {
        algorithmNotice: {
          itemKey: "health_score_algorithm:2",
          dismissed: true,
        },
      },
    });
  });
});

/**
 * v1.38 — the basis line, and the promise it carries.
 *
 * Two domains score now, and one does. The panel's whole job at those
 * breadths is to say so without saying it apologetically: the number keeps
 * its size and its band colour, the bar stays, and a single sentence under
 * the band states the scope. What the panel must NOT grow is a second
 * visual language for narrow scores — a smaller number, a drained colour,
 * a warning glyph, a gate. The number's own markup is compared against the
 * full-breadth render rather than pattern-matched, because "renders the
 * same" is the actual claim and a class list is the only place it can
 * break.
 */
describe("<HealthScoreCard> basis line", () => {
  function withBasis(
    domains: number,
    tier: "full" | "partial" | "minimal",
    band: "green" | "yellow" | "red" = "green",
  ): HealthScoreReport {
    return scoredReport({
      composite: {
        status: "ok",
        value: {
          score: 86,
          band,
          bandSetter: null,
          composition: ["BLOOD_PRESSURE"],
          configured: false,
          scoreBasis: { domains, recommended: 3, tier, physiological: true },
          noiseFloor: 3,
          scoreVersion: SCORE_VERSION,
        },
        coverage: {
          requiredInputs: 3,
          presentInputs: domains,
          historyDays: 28,
          missing: [],
        },
        confidence: { score: 70, band: "medium" },
        provenance,
      },
    } as Partial<HealthScoreReport>);
  }

  /** The opening tag of the headline number, classes and all. */
  function numberTag(html: string): string {
    const match = html.match(
      /<span data-slot="health-score-card-number"[^>]*>/,
    );
    expect(match, "the headline number is missing").not.toBeNull();
    return match![0];
  }

  it("states the scope of a two-area score", () => {
    const html = render(<HealthScoreCard report={withBasis(2, "partial")} />);
    expect(atRest(html)).toContain('data-slot="health-score-basis"');
    expect(html).toContain("Based on 2 of 3 areas of health.");
  });

  it("states the scope of a one-area score", () => {
    const html = render(<HealthScoreCard report={withBasis(1, "minimal")} />);
    expect(html).toContain("Based on 1 of 3 areas of health.");
  });

  it("renders a partial score's number exactly as a full one's", () => {
    const partial = render(
      <HealthScoreCard report={withBasis(1, "minimal")} />,
    );
    const full = render(<HealthScoreCard report={withBasis(3, "full")} />);

    // Byte-for-byte: same size classes, same band colour, same slot.
    expect(numberTag(partial)).toBe(numberTag(full));
    expect(numberTag(partial)).toContain("text-5xl");
    expect(numberTag(partial)).toContain("sm:text-6xl");
    expect(numberTag(partial)).toContain("text-success");
    // And the number itself is there, at full value, with its bar.
    expect(partial).toContain(">86<");
    expect(partial).toContain("/ 100");
    expect(partial).toContain('data-slot="health-score-card-progress"');
    expect(partial).toMatch(
      /data-slot="health-score-card"[^>]*data-status="ok"/,
    );
    expect(partial).toMatch(
      /data-slot="health-score-card"[^>]*data-band="green"/,
    );
  });

  it("keeps a red partial score in its own band colour", () => {
    // The band drag is arithmetic and the tier is labelling; a narrow set
    // may not recolour the number either way.
    const html = render(
      <HealthScoreCard report={withBasis(1, "minimal", "red")} />,
    );
    expect(numberTag(html)).toContain("text-destructive");
  });

  it("adds no gate, no alert and no glyph beside a narrow score", () => {
    const html = render(<HealthScoreCard report={withBasis(1, "minimal")} />);
    const rest = atRest(html);
    expect(rest).not.toContain('data-slot="health-score-insufficient"');
    expect(rest).not.toMatch(/enough recent data to score yet/i);
    // The only `role="alert"` this panel has ever carried is the failed
    // read; a narrow score is not a failure and must not borrow it.
    expect(rest).not.toContain('role="alert"');
    expect(rest).toContain('data-slot="health-score-band"');
  });

  it("says nothing extra once the recommended breadth is met", () => {
    const html = render(<HealthScoreCard report={withBasis(3, "full")} />);
    expect(html).not.toContain('data-slot="health-score-basis"');
    expect(html).not.toMatch(/Based on \d+ of 3 areas/);
  });

  it("says nothing when the composite carries no basis at all", () => {
    // An older cached payload. The line is a server-resolved fact; the
    // panel never counts domains out of `composition` to invent one.
    const html = render(<HealthScoreCard report={scoredReport()} />);
    expect(html).not.toContain('data-slot="health-score-basis"');
  });

  it("still shows the gate, and only the gate, on a refusal", () => {
    const html = render(<HealthScoreCard report={report()} />);
    expect(html).toContain('data-slot="health-score-insufficient"');
    expect(html).not.toContain('data-slot="health-score-basis"');
    expect(html).toContain("—");
    expect(html).not.toContain('data-slot="health-score-card-progress"');
  });
});

/**
 * v1.38 — the line that says why the number moved when nobody moved it.
 *
 * The delta was already suppressed for this case, which is the half of the
 * job that stops a lie. This is the other half: the level changed, and
 * until now the panel said nothing at all about it.
 *
 * The reason comes from the departed pillar's own row, so the line and the
 * anatomy list can never disagree — asserted by comparing against the
 * string the list itself renders rather than against a copy of the copy.
 */
describe("<HealthScoreCard> composition notice", () => {
  function withNotice(
    notice: HealthScoreReport["compositionNotice"],
    pillars = [
      BLOOD_PRESSURE,
      gatedPillar("SLEEP", "below_night_floor_or_stale"),
    ],
  ): HealthScoreReport {
    return scoredReport({ pillars, compositionNotice: notice });
  }

  const SLEEP_LEFT: NonNullable<HealthScoreReport["compositionNotice"]> = {
    itemKey: "health-score:v3:composition:abc123abc123",
    left: ["SLEEP"],
    joined: [],
    dismissed: false,
  };

  it("names the departed pillar and the reason its own row gives", () => {
    const html = render(
      <HealthScoreCard report={withNotice({ ...SLEEP_LEFT })} />,
    );
    const line = html.match(
      /data-slot="health-score-composition-notice"[^>]*>([^<]*)</,
    );
    expect(line, "the composition line is missing").not.toBeNull();
    expect(line![1]).toContain("Sleep");
    // The exact reason the anatomy list uses for that pillar, not a second
    // wording of it.
    expect(line![1]).toContain("Not enough recent eligible data");
  });

  it("says a pillar joined without inventing a reason for it", () => {
    const html = render(
      <HealthScoreCard
        report={withNotice({
          itemKey: "health-score:v3:composition:def456def456",
          left: [],
          joined: ["LIPIDS"],
          dismissed: false,
        })}
      />,
    );
    const line = html.match(
      /data-slot="health-score-composition-notice"[^>]*>([^<]*)</,
    );
    expect(line![1]).toContain("Lipids");
    expect(line![1]).not.toContain("Not enough recent eligible data");
  });

  it("falls back to the generic verdict for a pillar with no row left at all", () => {
    // Switching a module off stops the scorer emitting the pillar. It is
    // not waiting for anything, and claiming it is would nag a person in
    // the voice of their own settings.
    const html = render(
      <HealthScoreCard
        report={withNotice({ ...SLEEP_LEFT }, [BLOOD_PRESSURE])}
      />,
    );
    const line = html.match(
      /data-slot="health-score-composition-notice"[^>]*>([^<]*)</,
    );
    expect(line![1]).toContain("Sleep");
    expect(line![1]).toContain("This pillar is not currently eligible");
  });

  it("stays quiet once it has been acknowledged", () => {
    const html = render(
      <HealthScoreCard
        report={withNotice({ ...SLEEP_LEFT, dismissed: true })}
      />,
    );
    expect(html).not.toContain('data-slot="health-score-composition-notice"');
  });

  it("stays quiet when the report carries no notice at all", () => {
    expect(render(<HealthScoreCard report={scoredReport()} />)).not.toContain(
      'data-slot="health-score-composition-notice"',
    );
    expect(render(<HealthScoreCard report={withNotice(null)} />)).not.toContain(
      'data-slot="health-score-composition-notice"',
    );
  });

  it("is a muted line at rest, not a gate and not an alert", () => {
    const rest = atRest(
      render(<HealthScoreCard report={withNotice({ ...SLEEP_LEFT })} />),
    );
    expect(rest).toContain('data-slot="health-score-composition-notice"');
    expect(rest).toMatch(
      /data-slot="health-score-composition-notice"[^>]*class="[^"]*text-muted-foreground/,
    );
    expect(rest).not.toContain('role="alert"');
    expect(rest).not.toContain('data-slot="health-score-insufficient"');
  });
});

describe("markCompositionNoticeDismissed", () => {
  it("patches the composition notice and leaves the algorithm notice alone", () => {
    const payload = {
      healthScore: report({
        algorithmNotice: {
          itemKey: "health_score_algorithm:3",
          dismissed: false,
        },
        compositionNotice: {
          itemKey: "health-score:v3:composition:abc123abc123",
          left: ["SLEEP"],
          joined: [],
          dismissed: false,
        },
      }),
    };
    const patched = markCompositionNoticeDismissed(
      payload,
      "health-score:v3:composition:abc123abc123",
    ) as { healthScore: HealthScoreReport };
    expect(patched.healthScore.compositionNotice!.dismissed).toBe(true);
    expect(patched.healthScore.algorithmNotice!.dismissed).toBe(false);
  });

  it("leaves a payload alone when the key names a different set", () => {
    const payload = {
      healthScore: report({
        compositionNotice: {
          itemKey: "health-score:v3:composition:abc123abc123",
          left: ["SLEEP"],
          joined: [],
          dismissed: false,
        },
      }),
    };
    const patched = markCompositionNoticeDismissed(
      payload,
      "health-score:v3:composition:999999999999",
    ) as { healthScore: HealthScoreReport };
    expect(patched.healthScore.compositionNotice!.dismissed).toBe(false);
  });
});
