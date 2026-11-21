import type { Derived } from "@/lib/insights/derived/types";

import type { LipidReading, LipidsPillarInput, PillarValue } from "./types";
import {
  coverage,
  failedPillar,
  insufficientPillar,
  okPillar,
  scoreReferenceBand,
  uniqueSources,
  withinWindow,
} from "./shared";
import { mean } from "@/lib/stats/central";

export const LIPIDS_WINDOW_DAYS = 365;
export const LIPIDS_MIN_PANELS = 1;

function panelKey(row: LipidReading): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- baseline: grouping key only, never shown; the readings of one panel share one takenAt, so any consistent day partition groups them alike
  return `${row.at.toISOString().slice(0, 10)}|${row.panel ?? ""}`;
}

export function computeLipidsPillar(
  input: LipidsPillarInput,
): Derived<PillarValue> {
  if (input.readFailed) {
    return failedPillar({
      id: "LIPIDS",
      asOf: input.asOf,
      windowDays: LIPIDS_WINDOW_DAYS,
    });
  }

  const fresh = input.rows
    .filter(
      (row) =>
        (row.referenceLow != null || row.referenceHigh != null) &&
        withinWindow(row.at, input.asOf, LIPIDS_WINDOW_DAYS),
    )
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const latestKey = fresh[0] ? panelKey(fresh[0]) : null;
  const panel = latestKey
    ? fresh.filter((row) => panelKey(row) === latestKey)
    : [];

  if (panel.length === 0) {
    return insufficientPillar({
      id: "LIPIDS",
      source: input.source,
      asOf: input.asOf,
      windowDays: LIPIDS_WINDOW_DAYS,
      requiredInputs: LIPIDS_MIN_PANELS,
      presentInputs: 0,
      historyDays: 0,
      missing: ["lipid panel with lab reference ranges"],
      reason:
        input.rows.length > 0 ? "incomplete_or_stale_panel" : "not_tracked",
    });
  }

  const markerScores = panel.map((row) =>
    scoreReferenceBand(row.value, row.referenceLow, row.referenceHigh),
  );
  const latestAt = panel.reduce(
    (latest, row) => (row.at > latest ? row.at : latest),
    panel[0].at,
  );
  const observedLabel = panel
    .map((row) => `${row.marker} ${row.value} ${row.unit}`)
    .join("; ");
  const referenceLabel = panel
    .map((row) => {
      const bounds =
        row.referenceLow != null && row.referenceHigh != null
          ? `${row.referenceLow}–${row.referenceHigh}`
          : row.referenceHigh != null
            ? `≤ ${row.referenceHigh}`
            : `≥ ${row.referenceLow}`;
      return `${row.marker} ${bounds} ${row.unit}`;
    })
    .join("; ");

  return okPillar({
    id: "LIPIDS",
    source: input.source,
    asOf: input.asOf,
    windowDays: LIPIDS_WINDOW_DAYS,
    coverage: coverage({
      requiredInputs: LIPIDS_MIN_PANELS,
      presentInputs: LIPIDS_MIN_PANELS,
      historyDays: 1,
    }),
    value: {
      score: mean(markerScores)!,
      observed: {
        value: panel.length,
        unit: panel.length === 1 ? "result" : "results",
        label: observedLabel,
        asOf: latestAt.toISOString(),
        sources: uniqueSources(panel.map((row) => row.source)),
      },
      reference: {
        kind: "clinical-threshold",
        low: null,
        high: null,
        label: referenceLabel,
        source: "reporting laboratory reference ranges",
      },
      noiseFloor: 0,
      deltaEligible: false,
      deltaIdentity: `panel:${latestKey}`,
    },
  });
}
