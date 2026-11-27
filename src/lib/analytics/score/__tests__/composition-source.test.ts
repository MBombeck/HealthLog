/**
 * v1.35.0 — what decides the Health Score's composition, pinned.
 *
 * The module switches used to decide it alone, from a stack of ternaries
 * inside the reader that nothing could see and nothing tested. This file
 * is the regression test the capability audit found missing, written for
 * the NEW semantics: the stored recipe says what counts, the modules say
 * what there can be data for, and the score takes the intersection.
 *
 * Three promises live here.
 *
 * 1. **Nobody's number moves on upgrade.** Every module combination with
 *    a never-written recipe resolves to exactly the set the ternaries
 *    built. The old expression is reproduced verbatim below as
 *    `compositionBeforeTheSwap`, so this is a real before-and-after
 *    comparison rather than a restatement of the new code.
 *
 * 2. **A module that is off removes the pillar entirely.** Not a score,
 *    not a "waiting for data" line, no row at all. That line belongs to
 *    a pillar someone selected and could still record today; a module
 *    they switched off is not waiting for anything.
 *
 * 3. **One breadth rule, applied twice.** The settings write refuses a
 *    selection that cannot produce a score; the reader grades the set it
 *    resolved through the same rule. The block at the bottom drives the
 *    REAL reader and asserts the basis it published is
 *    `evaluateScoreBreadth`'s verdict on the reader's own resolved set,
 *    so a second copy of the rule that disagreed would show up here.
 *
 * The reader runs against a fake Prisma rather than hand-built pillar
 * inputs on purpose: the composition is assembled halfway down that
 * function, and a test that skips it would prove the wrong end.
 */
import { describe, expect, it } from "vitest";

import type {
  GlucoseContext,
  MeasurementSource,
  MeasurementType,
  PrismaClient,
  SleepStage,
} from "@/generated/prisma/client";
import { MODULE_KEYS } from "@/lib/modules/registry";

import { evaluateScoreBreadth } from "../breadth";
import { healthScoreConfigFromSelection } from "../config";
import {
  MODULE_GATED_PILLARS,
  MODULE_SCORE_PILLARS,
  pillarsWithModuleData,
  type ScoreModuleKey,
  type ScoreReaderModules,
} from "../modules";
import { computeUserHealthScore } from "../reader";
import { SCORE_PILLAR_IDS, type ScorePillarId } from "../types";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const DAY_MS = 86_400_000;

/**
 * Pillars the catalogue has retired since the swap.
 *
 * FITNESS went in v1.35.1. It had never produced a value on any account —
 * the schema cannot prove a VO₂max reading came from a measured test, so
 * every FITNESS row reached the scorer unproven and was refused — which
 * is why retiring it moves no number. It is named here rather than edited
 * out of the frozen expression below, so the "before" side stays a
 * verbatim copy and the retirement stays a visible, deliberate subtraction
 * instead of a silent one.
 */
const RETIRED_SINCE_THE_SWAP: readonly string[] = ["FITNESS"];

/**
 * The `availablePillars` expression exactly as it stood before the swap,
 * kept here as the "before" side of the inheritance proof. It must never
 * be edited to follow the implementation: the day it disagrees with the
 * reader is the day somebody's number moved. The one sanctioned
 * subtraction is `RETIRED_SINCE_THE_SWAP`, applied below.
 */
function compositionBeforeTheSwap(modules: ScoreReaderModules): string[] {
  return [
    "BLOOD_PRESSURE",
    ...(modules.glucose || modules.labs ? (["GLYCAEMIA"] as const) : []),
    "ACTIVITY",
    ...(modules.sleep ? (["SLEEP"] as const) : []),
    "ADIPOSITY",
    ...(modules.mentalHealth ? (["WELLBEING"] as const) : []),
    "FITNESS",
    ...(modules.labs ? (["LIPIDS"] as const) : []),
  ];
}

/** The pre-swap composition minus the pillars the catalogue has retired. */
function compositionInheritedToday(modules: ScoreReaderModules): string[] {
  return compositionBeforeTheSwap(modules).filter(
    (id) => !RETIRED_SINCE_THE_SWAP.includes(id),
  );
}

/** All sixteen on/off states of the four modules the reader is handed. */
const MODULE_COMBINATIONS: ScoreReaderModules[] = [0, 1].flatMap((glucose) =>
  [0, 1].flatMap((labs) =>
    [0, 1].flatMap((sleep) =>
      [0, 1].map((mentalHealth) => ({
        glucose: glucose === 1,
        labs: labs === 1,
        sleep: sleep === 1,
        mentalHealth: mentalHealth === 1,
      })),
    ),
  ),
);

const ALL_MODULES_ON: ScoreReaderModules = {
  glucose: true,
  labs: true,
  sleep: true,
  mentalHealth: true,
};

function describeModules(modules: ScoreReaderModules): string {
  const off = (Object.keys(modules) as ScoreModuleKey[]).filter(
    (key) => !modules[key],
  );
  return off.length === 0 ? "every module on" : `${off.join(" + ")} off`;
}

type MeasurementRow = {
  type: MeasurementType;
  value: number;
  unit: string;
  source: MeasurementSource;
  measuredAt: Date;
  deviceType: string | null;
  glucoseContext: GlucoseContext | null;
  sleepStage: SleepStage | null;
};

type AssessmentRow = {
  instrument: "PHQ9" | "GAD7" | "WHO5" | "SCI";
  totalScore: number;
  item9Flagged: boolean;
  takenAt: Date;
};

function measurement(
  type: MeasurementType,
  value: number,
  measuredAt: Date,
  extra: Partial<MeasurementRow> = {},
): MeasurementRow {
  return {
    type,
    value,
    unit: "",
    source: "MANUAL",
    measuredAt,
    deviceType: null,
    glucoseContext: null,
    sleepStage: null,
    ...extra,
  };
}

/**
 * An account with enough data for four pillars to score: steps, sleep,
 * a waist-to-height ratio and a WHO-5. Blood pressure, glycaemia and
 * lipids stay honestly absent, which is what lets the same fixture
 * show a selected-but-dataless pillar beside a module-withdrawn one.
 */
const MEASUREMENTS: MeasurementRow[] = [
  ...Array.from({ length: 45 }, (_, index) =>
    measurement(
      "ACTIVITY_STEPS",
      9_000,
      new Date(NOW.getTime() - (44 - index) * DAY_MS),
    ),
  ),
  ...Array.from({ length: 45 }, (_, index) =>
    measurement(
      "SLEEP_DURATION",
      450,
      new Date(
        new Date(NOW.getTime() - (44 - index) * DAY_MS).setUTCHours(6, 0, 0, 0),
      ),
      { sleepStage: "ASLEEP" },
    ),
  ),
  measurement("WAIST_TO_HEIGHT", 0.45, new Date(NOW.getTime() - 20 * DAY_MS)),
];

const ASSESSMENTS: AssessmentRow[] = [
  {
    instrument: "WHO5",
    totalScore: 80,
    item9Flagged: false,
    takenAt: new Date(NOW.getTime() - 20 * DAY_MS),
  },
];

function fakePrisma(): PrismaClient {
  return {
    measurement: {
      findMany: async (query: {
        where: {
          type: { in: MeasurementType[] };
          measuredAt: { gte: Date };
          glucoseContext?: GlucoseContext;
        };
      }) =>
        MEASUREMENTS.filter(
          (row) =>
            query.where.type.in.includes(row.type) &&
            row.measuredAt >= query.where.measuredAt.gte &&
            (query.where.glucoseContext === undefined ||
              row.glucoseContext === query.where.glucoseContext),
        ),
    },
    mentalHealthAssessment: { findMany: async () => ASSESSMENTS },
    labResult: { findMany: async () => [] },
    dismissedPriorityItem: { findUnique: async () => null },
    // v1.38 — no stored day behind this account, so the composition note
    // has nothing to compare against. These cases are about what the
    // recipe and the modules compose TODAY.
    healthScoreRecord: {
      findFirst: async () => null,
      findMany: async () => [],
    },
  } as unknown as PrismaClient;
}

function score(args: {
  modules: ScoreReaderModules;
  healthScoreConfigJson: unknown;
}) {
  return computeUserHealthScore({
    prisma: fakePrisma(),
    userId: "user-1",
    now: NOW,
    profile: {
      dateOfBirth: null,
      heightCm: null,
      timezone: "UTC",
      sourcePriorityJson: null,
      thresholdsJson: null,
      glucoseUnit: "mg/dL" as const,
    },
    modules: args.modules,
    healthScoreConfigJson: args.healthScoreConfigJson,
    bpTargets: null,
    bpEnvelope: null,
  });
}

/** A stored recipe, built through the same boundary the write route uses. */
function recipe(selection: readonly ScorePillarId[]): unknown {
  return healthScoreConfigFromSelection({
    selection,
    version: 1,
    changedAt: new Date("2026-08-01T00:00:00.000Z"),
  });
}

describe("the module-to-pillar map", () => {
  it("reproduces the ternaries it replaced, for every module combination", () => {
    for (const modules of MODULE_COMBINATIONS) {
      expect(
        pillarsWithModuleData(modules),
        `availability for ${describeModules(modules)}`,
      ).toEqual(compositionInheritedToday(modules));
    }
  });

  it("keeps glycaemia fed by either glucose or labs alone", () => {
    const both = { ...ALL_MODULES_ON, glucose: false, labs: false };
    expect(pillarsWithModuleData({ ...both, glucose: true })).toContain(
      "GLYCAEMIA",
    );
    expect(pillarsWithModuleData({ ...both, labs: true })).toContain(
      "GLYCAEMIA",
    );
    expect(pillarsWithModuleData(both)).not.toContain("GLYCAEMIA");
  });

  it("drops lipids with labs but never with glucose", () => {
    expect(
      pillarsWithModuleData({ ...ALL_MODULES_ON, labs: false }),
    ).not.toContain("LIPIDS");
    expect(
      pillarsWithModuleData({ ...ALL_MODULES_ON, glucose: false }),
    ).toContain("LIPIDS");
  });

  it("leaves the three core-domain pillars ungated", () => {
    // These read blood pressure, steps and waist — domains with no module
    // switch at all, so no module can withdraw their data. Pinned rather
    // than derived so an addition to the map that started gating one of
    // them has to be a deliberate edit here too.
    const ungated = SCORE_PILLAR_IDS.filter(
      (id) => !MODULE_GATED_PILLARS.has(id),
    );
    expect(ungated).toEqual(["BLOOD_PRESSURE", "ACTIVITY", "ADIPOSITY"]);
    const allOff: ScoreReaderModules = {
      glucose: false,
      labs: false,
      sleep: false,
      mentalHealth: false,
    };
    expect(pillarsWithModuleData(allOff)).toEqual(ungated);
  });

  it("holds no retired pillar the catalogue still knows", () => {
    // A retirement list that named a live pillar would quietly subtract
    // it from the "before" side and hide a real composition change.
    for (const id of RETIRED_SINCE_THE_SWAP) {
      expect(SCORE_PILLAR_IDS as readonly string[]).not.toContain(id);
    }
    // And the list is not empty-by-accident: the subtraction it performs
    // has to be visible in at least one module combination.
    expect(compositionBeforeTheSwap(ALL_MODULES_ON)).not.toEqual(
      compositionInheritedToday(ALL_MODULES_ON),
    );
  });

  it("names only real modules and real pillars", () => {
    for (const key of Object.keys(MODULE_SCORE_PILLARS) as ScoreModuleKey[]) {
      expect(MODULE_KEYS as readonly string[]).toContain(key);
      for (const id of MODULE_SCORE_PILLARS[key]) {
        expect(SCORE_PILLAR_IDS as readonly string[]).toContain(id);
      }
    }
  });
});

describe("inheritance: a never-written recipe keeps the number it had", () => {
  it("resolves the pre-swap composition for every module combination", async () => {
    for (const modules of MODULE_COMBINATIONS) {
      const report = await score({ modules, healthScoreConfigJson: null });
      expect(
        report.pillars.map((pillar) => pillar.id),
        `composition for ${describeModules(modules)}`,
      ).toEqual(compositionInheritedToday(modules));
    }
  });

  it("gives the sleep-module-off account the same composition and the same number as before", async () => {
    const modules = { ...ALL_MODULES_ON, sleep: false };
    const report = await score({ modules, healthScoreConfigJson: null });

    expect(report.pillars.map((pillar) => pillar.id)).toEqual([
      "BLOOD_PRESSURE",
      "GLYCAEMIA",
      "ACTIVITY",
      "ADIPOSITY",
      "WELLBEING",
      "LIPIDS",
    ]);
    expect(report.composite.status).toBe("ok");
    if (report.composite.status !== "ok") return;
    expect(report.composite.value.composition).toEqual([
      "ACTIVITY",
      "ADIPOSITY",
      "WELLBEING",
    ]);
    // Steps 9,000/day against the 10,000 plateau scores 90, a
    // waist-to-height of 0.45 scores 100, a WHO-5 of 80 scores 80, and
    // the mean is 90. The number itself is pinned, because "the
    // composition is right" and "the number did not move" are two
    // different claims and the second one is the promise.
    expect(report.composite.value.score).toBe(90);
  });

  it("cannot be re-included by a recipe that selects everything", async () => {
    const modules = { ...ALL_MODULES_ON, sleep: false };
    const inherited = await score({ modules, healthScoreConfigJson: null });
    const authored = await score({
      modules,
      healthScoreConfigJson: recipe([...SCORE_PILLAR_IDS]),
    });

    expect(authored.pillars.map((pillar) => pillar.id)).toEqual(
      inherited.pillars.map((pillar) => pillar.id),
    );
    expect(authored.composite.status).toBe("ok");
    if (authored.composite.status !== "ok") return;
    if (inherited.composite.status !== "ok") return;
    expect(authored.composite.value.score).toBe(
      inherited.composite.value.score,
    );
  });
});

describe("a module and a recipe answer different questions", () => {
  it("changes what is read, not what is composed, when a module is toggled", async () => {
    const selection = [...SCORE_PILLAR_IDS];
    const configJson = recipe(selection);

    const on = await score({
      modules: ALL_MODULES_ON,
      healthScoreConfigJson: configJson,
    });
    const off = await score({
      modules: { ...ALL_MODULES_ON, sleep: false },
      healthScoreConfigJson: configJson,
    });

    // The authored recipe is the same blob either way — the toggle wrote
    // nothing to it. What changed is whether sleep is being recorded.
    expect(on.pillars.map((pillar) => pillar.id)).toContain("SLEEP");
    expect(off.pillars.map((pillar) => pillar.id)).not.toContain("SLEEP");
    expect(off.pillars.map((pillar) => pillar.id)).toEqual(
      on.pillars.map((pillar) => pillar.id).filter((id) => id !== "SLEEP"),
    );

    // Sleep really is scoring in this fixture, so the toggle is moving a
    // pillar that counts rather than one that was absent anyway. Without
    // this the two assertions above would pass on an empty account.
    expect(
      on.pillars.find((pillar) => pillar.id === "SLEEP")?.result.status,
    ).toBe("ok");
    if (on.composite.status !== "ok" || off.composite.status !== "ok") {
      throw new Error("both windows should score");
    }
    expect(on.composite.value.composition).toContain("SLEEP");
    expect(off.composite.value.composition).not.toContain("SLEEP");
  });

  it("drops a deselected pillar even while its module keeps recording", async () => {
    const report = await score({
      modules: ALL_MODULES_ON,
      healthScoreConfigJson: recipe(
        SCORE_PILLAR_IDS.filter((id) => id !== "SLEEP"),
      ),
    });

    expect(report.pillars.map((pillar) => pillar.id)).not.toContain("SLEEP");
    expect(report.composite.status).toBe("ok");
    if (report.composite.status !== "ok") return;
    expect(report.composite.value.composition).not.toContain("SLEEP");
  });
});

describe("selected and waiting for data versus switched off", () => {
  it("keeps a selected pillar with no data as an honestly absent row", async () => {
    // Lipids is selected, labs is on, and there is no lab result. That is
    // the "selected, waiting for data" state: the row exists, it just has
    // nothing to score yet, and recording a lipid panel would fill it.
    const report = await score({
      modules: ALL_MODULES_ON,
      healthScoreConfigJson: recipe([...SCORE_PILLAR_IDS]),
    });

    const lipids = report.pillars.find((pillar) => pillar.id === "LIPIDS");
    expect(lipids).toBeDefined();
    expect(lipids?.result.status).toBe("insufficient");
  });

  it("shows nothing at all for a pillar whose module is off", async () => {
    // The decision this test exists to pin: a module the person switched
    // off is not "waiting" for anything. Telling them their score wants
    // sleep data they chose to stop recording would be nagging in the
    // voice of their own settings, and with a never-written recipe the
    // word "selected" would be describing a default they never picked.
    const report = await score({
      modules: { ...ALL_MODULES_ON, sleep: false },
      healthScoreConfigJson: recipe([...SCORE_PILLAR_IDS]),
    });

    expect(report.pillars.some((pillar) => pillar.id === "SLEEP")).toBe(false);
    if (report.composite.status !== "ok") return;
    expect(report.composite.value.composition).not.toContain("SLEEP");
  });

  it("never renders a switched-off module's pillar as a failed read", async () => {
    // Absence and failure carry different affordances. A module that is
    // off is neither: it produces no row, so it can never be mistaken
    // for a read that broke.
    const report = await score({
      modules: { ...ALL_MODULES_ON, mentalHealth: false },
      healthScoreConfigJson: null,
    });

    expect(report.pillars.some((pillar) => pillar.id === "WELLBEING")).toBe(
      false,
    );
  });
});

describe("the breadth rule still grades at read time", () => {
  // Inverted from the v1.35 pins, which asserted all three of these
  // recipes came back `insufficient`. Two of them produce a score now.
  // What the block proves has not moved — the reader publishes the shared
  // rule's verdict on the reader's own resolved set, so a second copy of
  // the rule that disagreed would still show up here — but the agreement
  // is over a tier rather than over a refusal.
  const NARROW: Array<{ what: string; selection: ScorePillarId[] }> = [
    {
      what: "a recipe that leaves two scoring areas",
      selection: ["ACTIVITY", "ADIPOSITY", "BLOOD_PRESSURE"],
    },
    {
      what: "a recipe with nothing physiological that scores",
      selection: ["ACTIVITY", "WELLBEING"],
    },
    {
      what: "a recipe of pillars that have no data at all",
      selection: ["BLOOD_PRESSURE", "GLYCAEMIA", "LIPIDS"],
    },
  ];

  for (const { what, selection } of NARROW) {
    it(`agrees with the shared rule on ${what}`, async () => {
      const report = await score({
        modules: ALL_MODULES_ON,
        healthScoreConfigJson: recipe(selection),
      });

      const scoring = report.pillars
        .filter((pillar) => pillar.result.status === "ok")
        .map((pillar) => pillar.id);
      const verdict = evaluateScoreBreadth(scoring);

      expect(report.composite.status).toBe(verdict.ok ? "ok" : "insufficient");
      if (report.composite.status === "ok") {
        // The published basis IS the shared rule's verdict on the
        // reader's set, not a second count taken on the way out.
        expect(report.composite.value.scoreBasis?.tier).toBe(verdict.tier);
        expect(report.composite.value.scoreBasis?.domains).toBe(
          verdict.domains.length,
        );
        expect(report.composite.value.scoreBasis?.physiological).toBe(
          verdict.physiological,
        );
      } else {
        // The one refusal that survives, reached the honest way: a recipe
        // whose three pillars all came back without data.
        expect(verdict.ok).toBe(false);
        expect(report.composite.reason).toBe("no_usable_data");
      }
    });
  }

  it("still produces a score when the recipe clears the rule", async () => {
    const report = await score({
      modules: ALL_MODULES_ON,
      healthScoreConfigJson: recipe([
        "ACTIVITY",
        "ADIPOSITY",
        "WELLBEING",
        "SLEEP",
      ]),
    });

    expect(report.composite.status).toBe("ok");
  });
});
