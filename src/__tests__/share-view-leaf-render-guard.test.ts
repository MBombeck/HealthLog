/**
 * Structural guard: every structured leaf the catalogue declares either
 * reaches the clinician view, or has a written, enforced reason why it cannot.
 *
 * Eleven leaves were selectable on a share link and invisible on the page it
 * served. Each of them had a control, a gating path in the aggregator and a
 * renderer in the PDF, so `doctor-report-control-gating-guard.test.ts` was
 * satisfied and stayed satisfied: it connects the picker to the aggregator,
 * and nothing connected either to the page. The two lists sat beside each
 * other for eleven releases without a test that could see both.
 *
 * This file is that connection. It is a pair guard in the same sense: one end
 * is `STRUCTURED_LEAF_GROUP`, the other is HTML rendered by the real
 * `<ClinicianView>` over a real fixture. It proves four things per leaf.
 *
 *   1. `DISPOSITIONS` is `Record<StructuredLeafId, …>`, so an eighteenth
 *      structured leaf cannot be added to the catalogue without deciding here
 *      whether it renders — and saying so — or `pnpm typecheck` fails. That is
 *      the lock, and it is the compiler's, not this suite's.
 *   2. A leaf marked `rendered` actually renders: its fixture's own marker
 *      appears in the page HTML.
 *   3. Removing exactly that leaf from the frozen selection removes the
 *      marker, with the payload left untouched. This is the both-ends half —
 *      a section that reads only "is there data" would pass (2) and fail (3),
 *      and several did before `LeafScope`.
 *   4. A leaf marked `refused` is refused where the disposition says it is,
 *      by reading `SHARE_LINK_FORBIDDEN_LEAVES` rather than taking the note's
 *      word for it.
 *
 * Plus, once over the whole set: a leaf on the link with no data behind it
 * says so in words, and one whose module is off says something different. A
 * blank card must never be the answer to either.
 *
 * Mutation checks are recorded per assertion below.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ClinicianView } from "@/components/clinician/clinician-view";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import { SHARE_LINK_FORBIDDEN_LEAVES } from "@/lib/validations/clinician-share-link";
import {
  ALL_LEAF_IDS,
  STRUCTURED_LEAF_IDS,
  type ReportLeafId,
  type StructuredLeafId,
} from "@/lib/report-selection/catalogue";
import { selectionFromLeaves } from "@/lib/report-selection/selection";
import type { DoctorReportData } from "@/lib/doctor-report-data";

/** The payload floor every fixture starts from: a link that carries nothing. */
function emptyReport(): DoctorReportData {
  return {
    period: {
      days: 30,
      since: "2026-01-01T00:00:00.000Z",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-31T00:00:00.000Z",
    },
    patient: {
      username: null,
      dateOfBirth: null,
      gender: null,
      heightCm: null,
    },
    practiceName: null,
    measurements: {},
    stats: {},
    glucoseStats: {},
    glucoseRanges: {},
    glucoseClinical: computeGlucoseClinicalMetrics([], {
      now: new Date("2026-01-31T00:00:00.000Z"),
    }),
    glucoseUnit: "mg/dL",
    bmi: null,
    compliance: {},
    medications: [],
    mood: null,
    wellnessScores: null,
  } as unknown as DoctorReportData;
}

function render(
  report: DoctorReportData,
  leaves: readonly ReportLeafId[],
  unavailableLeaves: readonly ReportLeafId[] = [],
): string {
  const { t } = getServerTranslator("en");
  return renderToStaticMarkup(
    ClinicianView({
      t: (key, vars) => t(key, vars),
      label: "Clinic",
      expiresAt: "2026-03-01T00:00:00.000Z",
      report,
      selection: selectionFromLeaves(leaves),
      unavailableLeaves,
      timeFormat: "AUTO",
      dateFormat: "AUTO",
    }),
  );
}

/**
 * Every leaf that has a card on the page, read off the `data-leaf` attributes.
 *
 * A card can speak for more than one leaf — the medications card carries the
 * drug list and the adherence rate together — so the attribute is a
 * space-separated list and a substring match on `data-leaf="LEAF"` would miss
 * exactly those.
 */
function renderedLeaves(html: string): Set<string> {
  const found = new Set<string>();
  for (const match of html.matchAll(/data-leaf="([^"]*)"/g)) {
    for (const leaf of match[1].split(" ")) {
      if (leaf) found.add(leaf);
    }
  }
  return found;
}

/** The markup of the card speaking for `leaf`, or "" when there is none. */
function cardFor(html: string, leaf: string): string {
  for (const match of html.matchAll(
    /<section data-leaf="([^"]*)"[\s\S]*?<\/section>/g,
  )) {
    if (match[1].split(" ").includes(leaf)) return match[0];
  }
  return "";
}

type Disposition =
  | {
      kind: "rendered";
      /** Payload that gives this leaf something to show. */
      data: Partial<DoctorReportData>;
      /** A string the page carries only when this leaf rendered. */
      marker: string;
    }
  | {
      kind: "refused";
      /** Why no renderer exists. Asserted, not trusted — see the suite below. */
      reason: string;
    };

/**
 * Every structured leaf, and what the clinician view does with it.
 *
 * `Record<StructuredLeafId, …>` is exhaustive over the closed union by the
 * compiler, mirroring how `STRUCTURED_LEAF_GROUP` forces a group decision in
 * the same commit as a new leaf. Adding one here is the same shape of work:
 * name the fixture and the marker, or name the refusal.
 */
const DISPOSITIONS: Record<StructuredLeafId, Disposition> = {
  PATIENT_IDENTITY: {
    kind: "rendered",
    data: {
      patient: {
        username: "shared-account",
        dateOfBirth: "1979-04-02T00:00:00.000Z",
        gender: "FEMALE",
        heightCm: 171,
        fullName: "A. Patient",
      },
    },
    marker: "A. Patient",
  },
  EMERGENCY: {
    kind: "rendered",
    data: {
      emergency: {
        bloodType: "O_NEG",
        organDonor: "YES",
        advanceDirective: "EXISTS",
        contacts: "Next of kin, 555 0100",
        contactsUnreadable: false,
        implants: "Pacemaker, fitted 2021",
        implantsUnreadable: false,
        note: null,
        noteUnreadable: false,
      },
    },
    marker: "Pacemaker, fitted 2021",
  },
  INSURANCE: {
    kind: "refused",
    reason:
      "Refused at share-link creation by SHARE_LINK_FORBIDDEN_LEAVES, so no " +
      "link can carry the leaf and the aggregator never fills the insurer " +
      "fields. A renderer here would be a path to a decision already made.",
  },
  GLUCOSE_PANEL: {
    kind: "rendered",
    data: {
      glucoseStats: {
        FASTING: { avg: 96, min: 88, max: 104, count: 21, latest: 94 },
      },
    },
    marker: "Glucose (fasting)",
  },
  LAB_RESULTS: {
    kind: "rendered",
    data: {
      labResults: [
        {
          panel: null,
          analyte: "Ferritin",
          value: 42,
          valueText: null,
          unit: "ng/mL",
          referenceLow: 30,
          referenceHigh: 400,
          catalogReferenceLow: 30,
          catalogReferenceHigh: 400,
          sourceReferenceText: null,
          referenceOrigin: "catalog",
          referenceDivergesFromCatalog: false,
          takenAt: "2026-01-20T09:00:00.000Z",
          count: 1,
        },
      ],
    },
    marker: "Ferritin",
  },
  MEDICATION_LIST: {
    kind: "rendered",
    data: {
      medications: [{ name: "Ramipril", dose: "5 mg", schedules: [] }],
    },
    marker: "Ramipril",
  },
  MEDICATION_ADMINISTRATIONS: {
    kind: "rendered",
    data: {
      medicationAdministrations: [
        {
          medicationName: "Ramipril",
          effectiveAt: "2026-01-30T07:10:00.000Z",
          status: "completed",
          doseText: "5 mg",
          dose: null,
          injectionSite: null,
          atcCode: null,
          rxNormCode: null,
          deliveryForm: "ORAL",
        },
      ],
    },
    marker: "Logged doses",
  },
  MEDICATION_COMPLIANCE: {
    kind: "rendered",
    data: {
      compliance: {
        Metformin: { total: 60, taken: 57, skipped: 1, missed: 2 },
      },
    },
    marker: "Metformin",
  },
  GLP1_THERAPY: {
    kind: "rendered",
    data: {
      glp1: {
        medications: [
          {
            name: "Semaglutide",
            currentDose: {
              value: 1,
              unit: "mg",
              since: "2026-01-05T00:00:00.000Z",
            },
            doseHistory: [],
            lastInjection: null,
            compliance: { taken: 4, total: 4 },
          },
        ],
        weightDeltaKg: null,
        weightStartKg: null,
        weightEndKg: null,
        sideEffects: [],
      },
    },
    marker: "Semaglutide",
  },
  ALLERGIES: {
    kind: "rendered",
    data: {
      allergies: [
        {
          substance: "Penicillin",
          category: "MEDICATION",
          type: "ALLERGY",
          severity: "SEVERE",
          status: "ACTIVE",
          reaction: null,
          reactionUnreadable: false,
        },
      ],
    },
    marker: "Penicillin",
  },
  ILLNESS_EPISODES: {
    kind: "rendered",
    data: {
      illnessEpisodes: [
        {
          label: "Sinusitis",
          type: "INFECTION",
          lifecycle: "ACUTE",
          onsetAt: "2026-01-08T00:00:00.000Z",
          resolvedAt: "2026-01-19T00:00:00.000Z",
        },
      ],
    },
    marker: "Sinusitis",
  },
  VISITS: {
    kind: "rendered",
    data: {
      visits: [
        {
          occurredAt: "2026-01-14T08:30:00.000Z",
          kind: "SPECIALIST",
          status: "DONE",
          practitionerName: "Cardiology outpatients",
          practitionerSpecialty: null,
          reason: "Palpitations",
          outcome: null,
          conditionLabels: [],
        },
      ],
    },
    marker: "Palpitations",
  },
  IMMUNIZATIONS: {
    kind: "rendered",
    data: {
      immunizations: [
        {
          occurredAt: "2025-11-03T00:00:00.000Z",
          antigenSlug: null,
          vaccineName: "Seasonal influenza",
          lotNumber: "LOT-7781",
          site: null,
          practitionerName: null,
          series: [],
        },
      ],
    },
    marker: "Seasonal influenza",
  },
  FAMILY_HISTORY: {
    kind: "rendered",
    data: {
      familyHistory: [
        {
          relationship: "MOTHER",
          condition: "Type 2 diabetes",
          ageAtOnset: 54,
        },
      ],
    },
    marker: "Type 2 diabetes",
  },
  MOOD: {
    kind: "rendered",
    data: {
      mood: {
        avg: 3.4,
        min: 2,
        max: 5,
        count: 22,
        distribution: { 1: 0, 2: 3, 3: 9, 4: 7, 5: 3 },
      },
    },
    marker: "Mood trajectory",
  },
  CYCLE: {
    kind: "rendered",
    data: {
      cycle: {
        lastPeriodStart: "2026-01-09",
        recentCycles: [
          { startDate: "2026-01-09", lengthDays: 29, periodLengthDays: 5 },
        ],
        observedCycleCount: 1,
        averageCycleLengthDays: 29,
        cycleLengthVariabilityDays: null,
        averagePeriodLengthDays: 5,
        currentPhase: "LUTEAL",
      },
    },
    marker: "Menstrual cycle",
  },
  ANAMNESIS: {
    kind: "rendered",
    data: {
      anamnesis: {
        conditions: "Hypothyroidism",
        conditionsUnreadable: false,
        smokingStatus: null,
        alcoholPattern: null,
        shiftSchedule: null,
        unreadableFacts: [],
      },
    },
    marker: "Hypothyroidism",
  },
};

const RENDERED = STRUCTURED_LEAF_IDS.filter(
  (leaf) => DISPOSITIONS[leaf].kind === "rendered",
);
const REFUSED = STRUCTURED_LEAF_IDS.filter(
  (leaf) => DISPOSITIONS[leaf].kind === "refused",
);

describe("clinician view — every catalogue leaf has a renderer or a reason", () => {
  it("reads a plausible catalogue", () => {
    // Sanity floor: a degraded import would satisfy every loop below
    // vacuously, which is the failure mode a pair guard dies of.
    expect(STRUCTURED_LEAF_IDS).toHaveLength(17);
    expect(Object.keys(DISPOSITIONS).sort()).toEqual(
      [...STRUCTURED_LEAF_IDS].sort(),
    );
    expect(RENDERED.length).toBeGreaterThan(0);
  });

  it("enforces every refusal where the disposition says it lives", () => {
    // Mutation: change INSURANCE to `rendered` and this fails on the count;
    // remove it from SHARE_LINK_FORBIDDEN_LEAVES and it fails on membership.
    expect(REFUSED).toEqual(["INSURANCE"]);
    for (const leaf of REFUSED) {
      expect(
        (SHARE_LINK_FORBIDDEN_LEAVES as readonly string[]).includes(leaf),
        `${leaf} claims to be refused at share-link creation but is not on ` +
          "SHARE_LINK_FORBIDDEN_LEAVES, so a link can carry it and nothing " +
          "will render it",
      ).toBe(true);
    }
  });

  for (const leaf of RENDERED) {
    const disposition = DISPOSITIONS[leaf];
    if (disposition.kind !== "rendered") continue;

    it(`renders ${leaf} when the link carries it`, () => {
      // Mutation: drop the section's element from `<ClinicianView>` and this
      // goes red for that leaf alone.
      const html = render(
        { ...emptyReport(), ...disposition.data },
        ALL_LEAF_IDS,
      );
      expect(html).toContain(disposition.marker);
    });

    it(`withholds ${leaf} when the link does not carry it`, () => {
      // The payload is IDENTICAL; only the frozen selection changes. Mutation:
      // gate the section on its data rather than on the scope and this goes
      // red while the test above stays green.
      const html = render(
        { ...emptyReport(), ...disposition.data },
        ALL_LEAF_IDS.filter((id) => id !== leaf),
      );
      expect(html).not.toContain(disposition.marker);
      expect(renderedLeaves(html).has(leaf)).toBe(false);
    });
  }
});

describe("clinician view — an absence names itself", () => {
  const EMPTY_COPY = "Included in this link, but nothing is recorded here.";
  const OFF_COPY = "switched off in the account it comes from";

  it("says so for every rendered leaf carried with nothing behind it", () => {
    // One render with everything selected and an empty payload: each card is
    // present and each says why it is blank. Mutation: return null from
    // `LeafSection` on `empty` and every one of these goes red.
    const html = render(emptyReport(), ALL_LEAF_IDS);
    const present = renderedLeaves(html);
    for (const leaf of RENDERED) {
      expect(present.has(leaf), `${leaf} renders no card at all`).toBe(true);
      expect(cardFor(html, leaf), `${leaf} renders a blank card`).toContain(
        EMPTY_COPY,
      );
    }
  });

  it("says something DIFFERENT when the owner's module is off", () => {
    // The distinction the payload cannot carry: shared-and-empty against
    // shared-and-switched-off. Mutation: drop the `unavailable` arm of
    // `LeafSection` and the two collapse into one sentence.
    const html = render(emptyReport(), ALL_LEAF_IDS, ["LAB_RESULTS"]);
    expect(cardFor(html, "LAB_RESULTS")).toContain(OFF_COPY);
    expect(cardFor(html, "LAB_RESULTS")).not.toContain(EMPTY_COPY);
    // And it is not the blanket answer: a leaf whose module is on still gets
    // the empty sentence.
    expect(cardFor(html, "MOOD")).toContain(EMPTY_COPY);
    expect(cardFor(html, "MOOD")).not.toContain(OFF_COPY);
  });

  it("renders nothing at all for a leaf the link never carried", () => {
    // The third state, and the one that must stay silent: no card, no
    // sentence, no acknowledgement that the leaf exists.
    const html = render(emptyReport(), ["WEIGHT"]);
    const present = renderedLeaves(html);
    for (const leaf of STRUCTURED_LEAF_IDS) {
      expect(
        present.has(leaf),
        `${leaf} is announced on a link that withheld it`,
      ).toBe(false);
    }
    expect(html).not.toContain(EMPTY_COPY);
    expect(html).not.toContain(OFF_COPY);
  });
});

describe("clinician view — the machine-format downloads", () => {
  // `data-testid="share-downloads"` had zero references anywhere in the tree:
  // the two buttons a practice actually clicks were unasserted, so the row
  // could have lost a link, pointed at the wrong path, or stopped rendering
  // for a documents-only share without a single test noticing.
  function renderWithToken(token: string, documentOnly = false): string {
    const { t } = getServerTranslator("en");
    return renderToStaticMarkup(
      ClinicianView({
        t: (key, vars) => t(key, vars),
        label: "Clinic",
        expiresAt: "2026-03-01T00:00:00.000Z",
        report: documentOnly ? null : emptyReport(),
        selection: selectionFromLeaves(["WEIGHT"]),
        documentOnly,
        token,
        timeFormat: "AUTO",
        dateFormat: "AUTO",
      }),
    );
  }

  it("offers both formats, scoped to the link's own token", () => {
    const html = renderWithToken("hls_abc");
    expect(html).toContain('data-testid="share-downloads"');
    expect(html).toContain('href="/c/hls_abc/report.pdf"');
    expect(html).toContain('href="/c/hls_abc/fhir"');
    expect(html).toContain("Download as PDF");
    expect(html).toContain("Download as FHIR");
  });

  it("percent-encodes the token into the download hrefs", () => {
    // The token reaches the DOM as a URL segment; it is server-minted hex
    // today, and the encoding is what keeps that from being load-bearing.
    expect(renderWithToken("hls_a/b?c")).toContain(
      'href="/c/hls_a%2Fb%3Fc/report.pdf"',
    );
  });

  it("offers no download on a documents-only link", () => {
    // There is no record behind such a link — both routes answer the same
    // flat 404 — so a button that produced one would be a lie in the markup.
    const html = renderWithToken("hls_abc", true);
    expect(html).not.toContain('data-testid="share-downloads"');
    expect(html).not.toContain("/report.pdf");
    expect(html).not.toContain("/fhir");
  });
});
