/**
 * Worked response examples published in `docs/api/openapi.yaml`, so a client
 * can decode the exact bytes the server sends and both ends pin the same
 * payload in their tests.
 *
 * Each example is what the server's own code produces for the input written
 * beside it, not a hand-drawn shape: `src/__tests__/openapi-examples.test.ts`
 * runs the real builder (`buildDailyTotalBaseline`, `labValuesFromText`) on
 * that input and compares, and parses every example with the response schema
 * it is published under. Synthetic values only.
 */
import type { InboundDocumentDetailDto } from "@/lib/validations/inbound-documents";
import type { SameTimeBaselineDailyTotalValue } from "@/lib/insights/derived/same-time-baseline";
import type { ReadinessValue } from "@/lib/insights/derived/readiness";

/**
 * The day totals behind {@link sameTimeBaselineDailyTotalExample}: fourteen
 * complete days from a source that reports one total per day, and today's
 * running total so far.
 */
export const SAME_TIME_DAILY_TOTAL_EXAMPLE_INPUT = {
  type: "ACTIVITY_STEPS",
  unit: "steps",
  timezone: "Europe/Vienna",
  dateKey: "2026-11-24",
  computedAt: "2026-11-24T13:20:05.000Z",
  history: [
    8200, 10450, 7600, 12100, 9300, 6800, 11200, 9900, 8700, 10100, 7300, 9600,
    11800, 8900,
  ],
  historyFirstDay: 10,
  historyUpdatedAt: "T21:40:00.000Z",
  today: { total: 6420, updatedAt: "2026-11-24T13:12:00.000Z" },
  source: "GARMIN",
} as const;

/** `GET /api/insights/derived?metric=SAME_TIME_BASELINE&type=ACTIVITY_STEPS`, `daily_total` form. */
export const sameTimeBaselineDailyTotalExample = {
  data: {
    metric: "SAME_TIME_BASELINE",
    status: "ok",
    value: {
      mode: "daily_total",
      type: "ACTIVITY_STEPS",
      unit: "steps",
      timezone: "Europe/Vienna",
      dateKey: "2026-11-24",
      todayValue: 6420,
      typicalValue: 9450,
      typicalLow: 8325,
      typicalHigh: 10362.5,
      percentOfTypical: 68,
      dayRangeReached: "not_yet",
      source: "GARMIN",
      updatedAt: "2026-11-24T13:12:00.000Z",
      baselineDays: 14,
      windowDays: 14,
    } satisfies SameTimeBaselineDailyTotalValue,
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 14,
      missing: [],
    },
    confidence: { score: 100, band: "high" },
    provenance: {
      inputs: ["ACTIVITY_STEPS"],
      source: "live",
      windowDays: 14,
      computedAt: "2026-11-24T13:20:05.000Z",
    },
    reason: null,
    assessment: null,
    ai: { available: true, reason: null, onDeviceAllowed: true },
  },
  error: null,
};

/** The stored text behind {@link inboundLabValuesExample}, as OCR read it. */
export const LAB_VALUES_EXAMPLE_TEXT = `Probeneingang: 03.11.2026
Natrium   141   mmol/l   135 - 145
Kreatinin   1,08   mg/dl   0,70 - 1,20
Thrombozyten   245   Tsd/pl   150 - 400`;

/**
 * `POST /api/documents/inbound/{id}/lab-values` on a scanned report whose
 * text is {@link LAB_VALUES_EXAMPLE_TEXT}. Two rows match a marker; the third
 * had its OCR unit repaired (`Tsd/pl` to `Tsd/µl`) and arrives with
 * `needsReview`. Like the AI extraction's answer, this one does not restate
 * the document's index, thumbnail or links (`hasContentIndex`,
 * `contentIndexSource` and `hasThumbnail` stay at false / null, the link lists
 * empty); `GET /api/documents/inbound/{id}` has them.
 */
export const inboundLabValuesExample: {
  data: InboundDocumentDetailDto;
  error: null;
} = {
  data: {
    id: "cmdoc0example0000000000001",
    kind: "LAB_RESULT",
    title: null,
    filename: "lab-2026-11-03.pdf",
    mimeType: "application/pdf",
    byteSize: 184320,
    status: "EXTRACTED",
    providerType: "local-parser",
    reportDate: "2026-11-03",
    documentDate: null,
    errorReason: null,
    factCount: 3,
    pendingCount: 3,
    conditionLinks: [],
    encounterLinks: [],
    servingClass: "inline",
    hasContentIndex: false,
    contentIndexSource: null,
    lastIndexAttemptAt: "2026-11-24T09:15:02.000Z",
    lastIndexOutcome: null,
    hasThumbnail: false,
    sourceSystem: null,
    sourceId: null,
    sourceUrl: null,
    createdAt: "2026-11-24T09:14:51.000Z",
    updatedAt: "2026-11-24T09:16:30.000Z",
    facts: [
      {
        id: "cmfact0example000000000001",
        factType: "OBSERVATION",
        status: "PENDING",
        confidence: 0.85,
        needsReview: false,
        data: {
          label: "Natrium",
          code: null,
          codeSystem: null,
          value: 141,
          valueText: null,
          unit: "mmol/l",
          referenceLow: 135,
          referenceHigh: 145,
          referenceText: "135 - 145",
          effectiveDate: null,
        },
        provenance: {
          sourceText: "Natrium   141   mmol/l   135 - 145",
          anchored: true,
          sourceOffset: 26,
          page: null,
          confidence: 0.85,
        },
        committedRecordId: null,
        committedRecordType: null,
        biomarkerId: "cmmarker0example00000000001",
        matchKind: "name",
        suggestions: [],
      },
      {
        id: "cmfact0example000000000002",
        factType: "OBSERVATION",
        status: "PENDING",
        confidence: 0.85,
        needsReview: false,
        data: {
          label: "Kreatinin",
          code: null,
          codeSystem: null,
          value: 1.08,
          valueText: null,
          unit: "mg/dl",
          referenceLow: 0.7,
          referenceHigh: 1.2,
          referenceText: "0,70 - 1,20",
          effectiveDate: null,
        },
        provenance: {
          sourceText: "Kreatinin   1,08   mg/dl   0,70 - 1,20",
          anchored: true,
          sourceOffset: 61,
          page: null,
          confidence: 0.85,
        },
        committedRecordId: null,
        committedRecordType: null,
        biomarkerId: "cmmarker0example00000000002",
        matchKind: "catalog",
        suggestions: [],
      },
      {
        id: "cmfact0example000000000003",
        factType: "OBSERVATION",
        status: "PENDING",
        confidence: 0.7,
        needsReview: true,
        data: {
          label: "Thrombozyten",
          code: null,
          codeSystem: null,
          value: 245,
          valueText: null,
          unit: "Tsd/µl",
          referenceLow: 150,
          referenceHigh: 400,
          referenceText: "150 - 400",
          effectiveDate: null,
        },
        provenance: {
          sourceText: "Thrombozyten   245   Tsd/pl   150 - 400",
          anchored: true,
          sourceOffset: 100,
          page: null,
          confidence: 0.7,
        },
        committedRecordId: null,
        committedRecordType: null,
        biomarkerId: null,
        matchKind: null,
        suggestions: [],
      },
    ],
    vaccinationLinks: [],
    summary: null,
    summaryGeneratedAt: null,
    summaryState: "NONE",
    extractionIncomplete: false,
    aiFailures: [],
  },
  error: null,
};

/**
 * The contributor scores behind the two READINESS examples, and the days
 * each counted input rests on. Fresh: every vital and the scored night are
 * from the reader's today. Stale: resting pulse and the night still rest on
 * the day before, so the blend is "last 61 on Nov 24", not today's.
 */
export const READINESS_EXAMPLE_INPUT = {
  todayKey: "2026-11-25",
  fresh: {
    raw: { rhr: 78, hrv: 64, sleep: 82, respiratory: 90, mood: null },
    vitalDays: ["2026-11-25", "2026-11-25", "2026-11-25"],
    sleepNight: "2026-11-25",
  },
  stale: {
    raw: { rhr: 61, hrv: 48, sleep: 66, respiratory: null, mood: 72 },
    vitalDays: ["2026-11-24", "2026-11-25"],
    sleepNight: "2026-11-24",
  },
} as const;

const readinessProvenance = {
  inputs: [
    "RESTING_HEART_RATE",
    "HEART_RATE_VARIABILITY",
    "SLEEP_DURATION",
    "RESPIRATORY_RATE",
  ],
  source: "DAY",
  windowDays: 30,
  computedAt: "2026-11-25T07:40:12.000Z",
};

/** `GET /api/insights/derived?metric=READINESS`, a blend that describes today. */
export const readinessFreshExample = {
  data: {
    metric: "READINESS",
    status: "ok",
    value: {
      score: 76,
      band: "green",
      components: [
        { key: "rhr", value: 78, weight: 0.29411764705882354 },
        { key: "hrv", value: 64, weight: 0.29411764705882354 },
        { key: "sleep", value: 82, weight: 0.29411764705882354 },
        { key: "respiratory", value: 90, weight: 0.11764705882352942 },
        { key: "mood", value: null, weight: 0 },
      ],
      series: [68, 71, 74, 70, 72, 76],
      asOfDay: "2026-11-25",
      fresh: true,
    } satisfies ReadinessValue,
    coverage: {
      requiredInputs: 5,
      presentInputs: 4,
      historyDays: 30,
      missing: ["mood"],
    },
    confidence: { score: 80, band: "high" },
    provenance: readinessProvenance,
    reason: null,
    assessment: null,
    ai: { available: true, reason: null, onDeviceAllowed: true },
  },
  error: null,
};

/**
 * `GET /api/insights/derived?metric=READINESS` early in the morning, before
 * the night and the day's resting pulse have synced. The blend is the last
 * one, from `asOfDay`; a client shows "last 61 on Nov 24" under an empty ring
 * and neither the band nor a sentence about today.
 */
export const readinessStaleExample = {
  data: {
    metric: "READINESS",
    status: "ok",
    value: {
      score: 61,
      band: "yellow",
      components: [
        { key: "rhr", value: 61, weight: 0.2777777777777778 },
        { key: "hrv", value: 48, weight: 0.2777777777777778 },
        { key: "sleep", value: 66, weight: 0.2777777777777778 },
        { key: "respiratory", value: null, weight: 0 },
        { key: "mood", value: 72, weight: 0.16666666666666666 },
      ],
      series: [70, 66, 64, 61],
      asOfDay: "2026-11-24",
      fresh: false,
    } satisfies ReadinessValue,
    coverage: {
      requiredInputs: 5,
      presentInputs: 4,
      historyDays: 30,
      missing: ["respiratory"],
    },
    confidence: { score: 80, band: "high" },
    provenance: {
      ...readinessProvenance,
      inputs: [
        "RESTING_HEART_RATE",
        "HEART_RATE_VARIABILITY",
        "SLEEP_DURATION",
        "MOOD",
      ],
    },
    reason: null,
    assessment: null,
    ai: { available: true, reason: null, onDeviceAllowed: true },
  },
  error: null,
};

/**
 * `healthScore.pillars` on `GET /api/dashboard/snapshot`, worded in English:
 * blood pressure and activity counted, sleep is not tracked, and the
 * wellbeing pillar is held back for safety signposting. Built from
 * {@link SCORE_PILLARS_EXAMPLE_INPUT} by `snapshotScorePillars`.
 */
export const SCORE_PILLARS_EXAMPLE_INPUT = [
  { id: "BLOOD_PRESSURE", score: 82 },
  { id: "ACTIVITY", score: 64.4 },
  { id: "SLEEP", reason: "not_tracked" },
  { id: "WELLBEING", reason: "crisis_signposting" },
] as const;

export const dashboardScorePillarsExample = [
  {
    id: "BLOOD_PRESSURE",
    label: "Blood pressure",
    value: 82,
    reason: null,
    reasonCode: null,
  },
  {
    id: "ACTIVITY",
    label: "Activity",
    value: 64,
    reason: null,
    reasonCode: null,
  },
  {
    id: "SLEEP",
    label: "Sleep",
    value: null,
    reason: "Not tracked",
    reasonCode: "not_tracked",
  },
  {
    id: "WELLBEING",
    label: "Wellbeing",
    value: null,
    reason: "Safety guidance is shown instead of a score",
    reasonCode: "crisis_signposting",
  },
];
