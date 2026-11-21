/**
 * v1.38 — the rule that keeps invented targets dead.
 *
 * The Health Score once graded weight against `22 × height²`, widened by
 * 2 kg either side: a band nobody set, no surface named, and the only
 * thing producing that pillar's verdict. v1.34 removed it and the rebuild
 * that followed left a pillar set where every scored band cites somebody.
 * Nothing but review has been keeping it that way since, and review is
 * what let the original in.
 *
 * So the rule the pillar set already obeys is written down here:
 *
 *   A pillar is scored against a cited clinical threshold, population
 *   band or guideline band, and nothing else. A yardstick belonging to
 *   the person rides `personalReference` beside the scored band (blood
 *   pressure does this) or stays unscored context (the weight goal). No
 *   band is synthesised from a profile field the person did not set.
 *
 * Three arms, because one is not enough to catch the class:
 *
 *   T1 — every scored reference names a citation, in one of the three
 *        declared kinds, free of first-person-yardstick vocabulary.
 *   T2 — the falsifiable one. Sweep every pillar across a matrix of
 *        profiles (height, age) and the scored bands it emits must fall
 *        inside a small enumerated set of PUBLISHED bands declared below.
 *        An invented target is a continuous function of a profile field;
 *        a guideline band is a step function into a published table. No
 *        finite enumeration can hold the former, which is precisely what
 *        makes this arm able to fail.
 *   T3 — the tripwire. Profile fields may be read inside a pillar module
 *        only where this file says so and says why, and every documented
 *        use must still exist.
 *
 * The mutation proof lives in T4: the pre-v1.34 weight pillar, restored
 * as a fixture in today's shape, is run through all three arms and each
 * rejects it. A check that cannot fail is worse than none.
 *
 * What the guard cannot do: judge whether a citation is HONEST. "ESH
 * 2023" could be attached to a band the ESH never published and every arm
 * would pass. It pins the shape of the promise and the set of values, not
 * the scholarship — that stays a reviewer's job.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Derived } from "@/lib/insights/derived/types";
import { gradeBpScore } from "@/lib/analytics/bp-grade";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { computeActivityPillar } from "../activity";
import { computeAdiposityPillar } from "../adiposity";
import { computeBloodPressurePillar } from "../blood-pressure";
import { computeGlycaemiaPillar } from "../glycaemia";
import { computeLipidsPillar } from "../lipids";
import { computeSleepPillar } from "../sleep";
import { computeWellbeingPillar } from "../wellbeing";
import {
  PILLAR_REFERENCE_KINDS,
  SCORE_PILLAR_IDS,
  type PillarReference,
  type PillarValue,
  type ScorePillarId,
} from "../types";
import { computeInventedTargetPillar } from "./fixtures/invented-target-pillar";

const SCORE_DIR = join(dirname(new URL(import.meta.url).pathname), "..");
const FIXTURE_FILE = join(
  SCORE_DIR,
  "__tests__",
  "fixtures",
  "invented-target-pillar.ts",
);

// ── arm 1: the citation ───────────────────────────────────────────────

/**
 * Vocabulary that belongs to a personal yardstick, not to a published
 * one. A scored band citing any of these is either graded against
 * something the person set — which belongs on `personalReference` — or
 * against something the app made up on their behalf, which belongs
 * nowhere. `personalReference` is exempt: naming itself is its job.
 */
const PERSONAL_YARDSTICK_WORDS =
  /\b(personal|personalised|personalized|your|yours|user|profile|goal|target|preference|default|derived|estimated|ideal|bmi|height|body\s*mass)\b/i;

/** The shortest thing anyone could call a citation. "ESH 2023" is eight. */
const MIN_CITATION_LENGTH = 4;

function auditCitation(label: string, ref: PillarReference): string[] {
  const problems: string[] = [];
  if (!(PILLAR_REFERENCE_KINDS as readonly string[]).includes(ref.kind)) {
    problems.push(
      `${label}: reference.kind "${ref.kind}" is not a declared kind`,
    );
  }
  const source = ref.source.trim();
  if (source.length < MIN_CITATION_LENGTH) {
    problems.push(
      `${label}: reference.source is not a citation (${JSON.stringify(ref.source)})`,
    );
  }
  const yardstick = PERSONAL_YARDSTICK_WORDS.exec(source);
  if (yardstick) {
    problems.push(
      `${label}: reference.source cites a personal yardstick ("${yardstick[0]}") — a band the person set rides personalReference, and a band nobody set rides nothing`,
    );
  }
  if (ref.label.trim().length === 0) {
    problems.push(
      `${label}: reference.label is empty, so nothing can name the band`,
    );
  }
  return problems;
}

// ── arm 2: the published set ──────────────────────────────────────────

/** Key a band by what it grades against, deliberately not by its label. */
function bandKey(ref: PillarReference): string {
  return `${ref.kind}|${ref.low}|${ref.high}|${ref.source}`;
}

function auditPublishedSet(
  label: string,
  emitted: PillarReference[],
  declared: readonly string[],
): string[] {
  const allowed = new Set(declared);
  const problems: string[] = [];
  for (const key of new Set(emitted.map(bandKey))) {
    if (!allowed.has(key)) {
      problems.push(
        `${label}: emitted a band outside its published set — ${key}. Either the guideline table moved (declare it here, with the citation) or the band is being synthesised per user.`,
      );
    }
  }
  return problems;
}

// ── arm 3: profile reads inside a pillar module ───────────────────────

/**
 * Identifiers that carry a profile fact into a pillar. `dateOfBirth`
 * never reaches a pillar module (the reader turns it into `ageYears`
 * first), and it is listed anyway so the day one does, this fails.
 */
const PROFILE_IDENTIFIERS = [
  "heightCm",
  "ageYears",
  "dateOfBirth",
  "birthDate",
] as const;

/**
 * Where a pillar may read a profile fact, and why it is not an invented
 * target. Both entries below resolve a PUBLISHED table by age — the step
 * the guideline itself publishes — or divide an observation, which moves
 * what is OBSERVED rather than what it is measured against.
 *
 * Stale entries fail as loudly as missing ones (T3b): a documented use
 * that no longer exists means this list has stopped describing the tree.
 */
const PROFILE_READ_ALLOWLIST: Record<
  string,
  ReadonlyArray<{ identifier: string; why: string }>
> = {
  "activity.ts": [
    {
      identifier: "ageYears",
      why: "picks between the two step plateaus Paluch 2022 publishes (10k under 60, 8k at 60+). Two published values, not a per-person curve.",
    },
  ],
  "sleep.ts": [
    {
      identifier: "ageYears",
      why: "indexes the NSF 2015 age-band need table via sleepNeedMinutes. The table is the guideline; age only says which row.",
    },
  ],
  "adiposity.ts": [
    {
      identifier: "heightCm",
      why: "divides the waist measurement into the waist-to-height RATIO, and names height as the missing input when it is absent. It moves the OBSERVED value; the band stays NICE 2022's 0.5 for everybody.",
    },
  ],
  "blood-pressure.ts": [],
  "glycaemia.ts": [],
  "lipids.ts": [],
  "wellbeing.ts": [],
};

function profileReadsIn(source: string): string[] {
  return PROFILE_IDENTIFIERS.filter((id) =>
    new RegExp(`\\b${id}\\b`).test(source),
  );
}

function auditProfileReads(
  label: string,
  source: string,
  allowed: ReadonlyArray<{ identifier: string; why: string }>,
): string[] {
  const permitted = new Set(allowed.map((entry) => entry.identifier));
  return profileReadsIn(source)
    .filter((id) => !permitted.has(id))
    .map(
      (id) =>
        `${label}: reads the profile field "${id}" with no documented reason. A band resolved from a profile field the person did not set is the invented target this guard exists for; if this use is legitimate, add it to PROFILE_READ_ALLOWLIST with its citation.`,
    );
}

// ── the pillar catalogue, as this guard sees it ───────────────────────

interface ProfileFixture {
  heightCm: number | null;
  ageYears: number | null;
}

/**
 * Wide enough to cross every published step in the tree: the BP age band
 * at 65, the activity plateau at 60, and the NSF sleep-need rows for a
 * child, a teenager and an adult. Heights bracket the adult range, which
 * is the axis the dead weight target varied along.
 */
const PROFILES: ProfileFixture[] = [];
for (const heightCm of [150, 165, 180, 195, null]) {
  for (const ageYears of [10, 16, 18, 40, 59, 60, 64, 65, 80, null]) {
    PROFILES.push({ heightCm, ageYears });
  }
}

const NOW = new Date("2026-08-01T12:00:00.000Z");
const live = {
  source: "live" as const,
  readFailed: false,
  timezone: "Europe/Berlin",
  glucoseUnit: "mg/dL" as const,
};

function days(count: number, value: number) {
  return Array.from({ length: count }, (_, index) => ({
    day: new Date(NOW.getTime() - index * 86_400_000)
      .toISOString()
      .slice(0, 10),
    value,
  }));
}

function dobForAge(ageYears: number | null): Date | null {
  if (ageYears == null) return null;
  return new Date(Date.UTC(new Date().getUTCFullYear() - ageYears, 0, 2));
}

/**
 * Keep the ok arms only. An insufficient pillar has no reference to
 * audit, and skipping it is not a hole: T0 refuses a pillar that never
 * scored across the whole matrix.
 */
function valuesOf(results: Derived<PillarValue>[]): PillarValue[] {
  return results.flatMap((result) =>
    result.status === "ok" ? [result.value] : [],
  );
}

/**
 * One entry per pillar in the catalogue: how to make it score, and the
 * complete set of bands it is allowed to score against.
 *
 * The declared sets are transcribed from the guideline each pillar cites.
 * Adding a band here is the deliberate act the guard is asking for — it
 * is where a reviewer is forced to name the publication.
 */
const PILLARS: Record<
  ScorePillarId,
  {
    module: string;
    /** Every scored value the pillar can produce across the profile matrix. */
    emit: (profile: ProfileFixture) => PillarValue[];
    /** Published bands, keyed by `bandKey`. */
    declared: readonly string[];
  }
> = {
  BLOOD_PRESSURE: {
    module: "blood-pressure.ts",
    emit: (profile) => {
      const target = getBpTargets(dobForAge(profile.ageYears), "UTC");
      if (!target) return [];
      return valuesOf([
        computeBloodPressurePillar({
          ...live,
          asOf: NOW,
          pairCount: 12,
          graded: gradeBpScore({ sys: 128, dia: 78, target }),
          representative: { sys: 128, dia: 78 },
          oldestAt: new Date(NOW.getTime() - 60 * 86_400_000),
          latestAt: new Date(NOW.getTime() - 86_400_000),
          target,
          personalTarget: {
            sysLow: 110,
            sysHigh: 120,
            diaLow: 65,
            diaHigh: 75,
          },
          sources: ["MANUAL"],
        }),
      ]);
    },
    // ESH 2023 (Mancia et al., J Hypertens 2023): systolic 120–129 under
    // 65, 130–139 at 65 and over. Two rows, resolved in bp-targets.ts.
    declared: [
      "clinical-threshold|120|129|ESH 2023",
      "clinical-threshold|130|139|ESH 2023",
    ],
  },
  GLYCAEMIA: {
    module: "glycaemia.ts",
    emit: (profile) => {
      void profile;
      const at = new Date(NOW.getTime() - 5 * 86_400_000);
      return valuesOf([
        computeGlycaemiaPillar({
          ...live,
          asOf: NOW,
          hba1c: [{ value: 5.2, unit: "%", at, source: "MANUAL" }],
          fastingGlucose: [],
        }),
        computeGlycaemiaPillar({
          ...live,
          asOf: NOW,
          hba1c: [],
          fastingGlucose: days(10, 92).map((point) => ({
            value: point.value,
            at: new Date(`${point.day}T08:00:00Z`),
            source: "APPLE_HEALTH",
          })),
        }),
      ]);
    },
    // ADA 2025 Standards of Care + Selvin 2010: HbA1c 5–5.6 %, fasting
    // plasma glucose 70–99 mg/dL. Constants in glycaemia.ts.
    declared: [
      "clinical-threshold|5|5.6|ADA 2025; Selvin 2010",
      "clinical-threshold|70|99|ADA 2025; Selvin 2010",
    ],
  },
  ACTIVITY: {
    module: "activity.ts",
    emit: (profile) =>
      valuesOf([
        computeActivityPillar({
          ...live,
          asOf: NOW,
          ageYears: profile.ageYears,
          days: days(24, 7_500),
          sources: ["APPLE_HEALTH"],
        }),
      ]),
    // Paluch 2022 (Lancet Public Health meta-analysis): the mortality
    // benefit of stepping plateaus near 10k/day under 60 and near 8k at
    // 60 and over. Two published values.
    declared: [
      "guideline-band|0|10000|Paluch 2022",
      "guideline-band|0|8000|Paluch 2022",
    ],
  },
  SLEEP: {
    module: "sleep.ts",
    emit: (profile) =>
      valuesOf([
        computeSleepPillar({
          ...live,
          asOf: NOW,
          ageYears: profile.ageYears,
          nights: days(22, 450).map((point, index) => ({
            night: point.day,
            asleepMinutes: point.value,
            midpoint: 180 + (index % 3),
          })),
          sources: ["APPLE_HEALTH"],
        }),
      ]),
    // NSF 2015 (Hirshkowitz et al.) lower-recommended bound per age row,
    // in minutes: 14 h infant, 12 h toddler, 11 h preschool, 10 h school
    // age, 9 h teen, 7 h adult. The rhythm citations ride the same string.
    declared: [840, 720, 660, 600, 540, 420].map(
      (need) =>
        `guideline-band|${need}|null|NSF 2015; Ai 2021; Daghlas 2019; Windred 2024`,
    ),
  },
  ADIPOSITY: {
    module: "adiposity.ts",
    emit: (profile) =>
      valuesOf([
        computeAdiposityPillar({
          ...live,
          asOf: NOW,
          heightCm: profile.heightCm,
          rows: [
            {
              type: "WAIST_CIRCUMFERENCE",
              value: 88,
              unit: "cm",
              at: new Date(NOW.getTime() - 3 * 86_400_000),
              source: "MANUAL",
            },
          ],
        }),
        computeAdiposityPillar({
          ...live,
          asOf: NOW,
          heightCm: profile.heightCm,
          rows: [
            {
              type: "WAIST_TO_HEIGHT",
              value: 0.47,
              unit: "ratio",
              at: new Date(NOW.getTime() - 3 * 86_400_000),
              source: "MANUAL",
            },
          ],
        }),
      ]),
    // NICE 2022 (CG189 update): keep waist-to-height below 0.5, at every
    // height and every age. One band for everybody — which is exactly why
    // heightCm may move the ratio and never the threshold.
    declared: ["clinical-threshold|0|0.5|NICE 2022"],
  },
  WELLBEING: {
    module: "wellbeing.ts",
    emit: (profile) => {
      void profile;
      const at = new Date(NOW.getTime() - 4 * 86_400_000);
      return valuesOf(
        (
          [
            ["PHQ9", 3],
            ["GAD7", 3],
            ["WHO5", 68],
          ] as const
        ).map(([instrument, totalScore]) =>
          computeWellbeingPillar({
            ...live,
            asOf: NOW,
            assessments: [{ instrument, totalScore, item9Flagged: false, at }],
          }),
        ),
      );
    },
    // The instruments' own published cut-points: PHQ-9 0–4 minimal
    // (Kroenke 2001), GAD-7 0–4 minimal (Spitzer 2006), WHO-5 at or above
    // 52 as the well-being floor (WHO 1998).
    declared: [
      "clinical-threshold|0|4|Kroenke 2001",
      "clinical-threshold|0|4|Spitzer 2006",
      "clinical-threshold|52|100|WHO 1998",
    ],
  },
  LIPIDS: {
    module: "lipids.ts",
    emit: (profile) => {
      void profile;
      return valuesOf([
        computeLipidsPillar({
          ...live,
          asOf: NOW,
          rows: [
            {
              marker: "LDL",
              value: 110,
              unit: "mg/dL",
              referenceLow: 0,
              referenceHigh: 130,
              panel: "Lipids",
              at: new Date(NOW.getTime() - 20 * 86_400_000),
              source: "MANUAL",
            },
          ],
        }),
      ]);
    },
    // The one pillar whose band is not transcribed from a guideline
    // here: it comes from the panel, which carries the reporting
    // laboratory's own ranges, one per marker. That is why the numeric
    // bounds are null and the band lives in the label — a multi-marker
    // panel has no single pair. T2's set arm is therefore thin for this
    // pillar and the test below carries its weight instead: the band
    // tracks what the LAB printed and never the person's profile.
    declared: [
      "clinical-threshold|null|null|reporting laboratory reference ranges",
    ],
  },
};

function moduleSource(file: string): string {
  return readFileSync(join(SCORE_DIR, file), "utf8");
}

describe("T0 — the guard sees the whole catalogue", () => {
  it("covers every pillar that can score", () => {
    expect(Object.keys(PILLARS).sort()).toEqual([...SCORE_PILLAR_IDS].sort());
    expect(Object.keys(PROFILE_READ_ALLOWLIST).sort()).toEqual(
      Object.values(PILLARS)
        .map((entry) => entry.module)
        .sort(),
    );
  });

  it("produces a scored band for every pillar, so no arm runs on nothing", () => {
    for (const [id, entry] of Object.entries(PILLARS)) {
      const emitted = PROFILES.flatMap(entry.emit);
      expect(
        emitted.length,
        `${id} never scored across the profile matrix`,
      ).toBeGreaterThan(0);
    }
  });

  it("matches the profile identifiers it is looking for", () => {
    // The matcher that matches nothing is green for the wrong reason.
    const matched = Object.values(PILLARS).flatMap((entry) =>
      profileReadsIn(moduleSource(entry.module)),
    );
    expect(matched.length).toBeGreaterThan(0);
  });
});

describe("T1 — every scored band names a citation", () => {
  for (const [id, entry] of Object.entries(PILLARS)) {
    it(`${id} cites a published yardstick`, () => {
      const values = PROFILES.flatMap(entry.emit);
      const problems = values.flatMap((value) =>
        auditCitation(id, value.reference),
      );
      expect(problems).toEqual([]);
    });
  }

  it("keeps a personal yardstick beside the scored band and never in it", () => {
    const withPersonal = PROFILES.flatMap(PILLARS.BLOOD_PRESSURE.emit).filter(
      (value) => value.personalReference != null,
    );
    expect(withPersonal.length).toBeGreaterThan(0);
    for (const value of withPersonal) {
      // The scored band still passes T1 — the personal one has not
      // displaced it — and the two are genuinely different bands.
      expect(auditCitation("BLOOD_PRESSURE", value.reference)).toEqual([]);
      expect(bandKey(value.personalReference!)).not.toBe(
        bandKey(value.reference),
      );
    }
  });
});

describe("T2 — a scored band comes from a published table, not from a person", () => {
  for (const [id, entry] of Object.entries(PILLARS)) {
    it(`${id} stays inside its published set across every profile`, () => {
      const emitted = PROFILES.flatMap(entry.emit).map(
        (value) => value.reference,
      );
      expect(auditPublishedSet(id, emitted, entry.declared)).toEqual([]);
    });
  }

  it("takes the lipid band from the panel the lab reported", () => {
    // The pillar with no numeric band of its own. What must hold is that
    // its band is a transcription of the range that arrived with the
    // panel — move the lab's ceiling and the band moves with it — and
    // that nothing about the person changes it.
    const panelAt = new Date(NOW.getTime() - 20 * 86_400_000);
    const withCeiling = (referenceHigh: number) =>
      computeLipidsPillar({
        ...live,
        asOf: NOW,
        rows: [
          {
            marker: "LDL",
            value: 110,
            unit: "mg/dL",
            referenceLow: 0,
            referenceHigh,
            panel: "Lipids",
            at: panelAt,
            source: "MANUAL",
          },
        ],
      });
    const [narrow, wide] = [withCeiling(115), withCeiling(160)];
    expect(narrow.status).toBe("ok");
    expect(wide.status).toBe("ok");
    if (narrow.status !== "ok" || wide.status !== "ok") return;
    expect(narrow.value.reference.label).toContain("115");
    expect(wide.value.reference.label).toContain("160");

    const acrossProfiles = new Set(
      PROFILES.flatMap(PILLARS.LIPIDS.emit).map(
        (value) => value.reference.label,
      ),
    );
    expect(acrossProfiles.size).toBe(1);
  });

  it("lets height move the observation and never the adiposity threshold", () => {
    // The shape the dead weight target got wrong, stated positively: the
    // profile field belongs on the left of the comparison, not the right.
    const scored = [150, 195].map(
      (heightCm) => PILLARS.ADIPOSITY.emit({ heightCm, ageYears: 40 })[0],
    );
    expect(scored[0].observed.value).not.toBe(scored[1].observed.value);
    expect(bandKey(scored[0].reference)).toBe(bandKey(scored[1].reference));
  });
});

describe("T3 — profile fields are read only where this file says why", () => {
  for (const [id, entry] of Object.entries(PILLARS)) {
    it(`${id} reads no undocumented profile field`, () => {
      const problems = auditProfileReads(
        id,
        moduleSource(entry.module),
        PROFILE_READ_ALLOWLIST[entry.module],
      );
      expect(problems).toEqual([]);
    });
  }

  it("has no stale entry — every documented use still exists", () => {
    for (const [file, entries] of Object.entries(PROFILE_READ_ALLOWLIST)) {
      const present = profileReadsIn(moduleSource(file));
      for (const entry of entries) {
        expect(
          present,
          `${file} no longer reads ${entry.identifier}; drop the entry so this list keeps describing the tree`,
        ).toContain(entry.identifier);
        expect(entry.why.length).toBeGreaterThan(40);
      }
    }
  });
});

describe("T4 — mutation proof: the pre-v1.34 weight target is rejected", () => {
  /**
   * The fixture is the band that shipped: `22 × height²`, ±2 kg. It is
   * run through the same three arms the real pillars are, and each has to
   * refuse it. If any of these stops failing, the arm above it has
   * stopped being a check.
   */
  const HEIGHTS = [150, 165, 180, 195];
  const inventedValues = HEIGHTS.map((heightCm) =>
    computeInventedTargetPillar({ heightCm, weightKg: 72, at: NOW })!,
  );

  it("the fixture still produces the band it did before v1.34", () => {
    // 22 × 1.80² = 71.3 kg, ±2. Guard against a fixture that quietly
    // stopped reproducing the defect it exists to reproduce.
    const at180 = computeInventedTargetPillar({
      heightCm: 180,
      weightKg: 72,
      at: NOW,
    })!;
    expect(at180.reference.low).toBe(69.3);
    expect(at180.reference.high).toBe(73.3);
  });

  it("T1 rejects it: the citation names the person, not a publication", () => {
    const problems = auditCitation(
      "INVENTED_WEIGHT",
      inventedValues[0].reference,
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain("personal yardstick");
  });

  it("T2 rejects it: no enumeration of published bands can hold it", () => {
    // The most generous declaration anyone could have written: the band
    // for one height, documented as though it were a guideline row. Every
    // other height escapes it, because the target is continuous in a
    // profile field and a published table is not.
    const declaredForOneHeight = [bandKey(inventedValues[2].reference)];
    const problems = auditPublishedSet(
      "INVENTED_WEIGHT",
      inventedValues.map((value) => value.reference),
      declaredForOneHeight,
    );
    expect(problems.length).toBe(HEIGHTS.length - 1);
    expect(problems.join(" ")).toContain("outside its published set");
  });

  it("T3 rejects it: it reads a profile field with no documented reason", () => {
    // A pillar joining the catalogue starts with an empty allowlist, so
    // the height read has to be argued for in this file before it can
    // ship. There is no argument for this one.
    const problems = auditProfileReads(
      "INVENTED_WEIGHT",
      readFileSync(FIXTURE_FILE, "utf8"),
      [],
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain("heightCm");
  });
});
