/**
 * Shared doctor-visit summariser — the ONE reducer behind both the
 * `healthlog://report/doctor-visit` resource (`resources.ts`) and the
 * `doctor_visit_summary` prompt (`prompts.ts`).
 *
 * Both surfaces must ground IDENTICALLY: the same vitals, medications,
 * adherence, labs, mood, glucose panel, wellness composites, and illness
 * episodes, with the same units + server-side reference bands. They had
 * drifted (the resource omitted mood / glucose panel / wellness / illness that
 * the prompt carried); folding the richer superset into one function makes a
 * future change reach both wires at once.
 *
 * Grounding discipline (ADR-004 / R-DEL-2): latest + aggregate per metric,
 * latest reading per analyte — never the full per-reading history. Every
 * numeric value is one the server already computed; every band is server-side.
 * Absence is honest — a section is omitted rather than zero-filled. No verdict,
 * no diagnosis.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { getMetricStatusMeta } from "@/lib/insights/metric-status-registry";
import { fenceUserText } from "@/lib/ai/coach/data-fence";

/**
 * Fallback units for the headline specialised metric types the generic
 * `metric-status-registry` intentionally omits (it carries the synced/additive
 * metrics only). The doctor-report stats map is keyed by `MeasurementType`.
 */
const FALLBACK_UNITS: Record<string, string> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_MASS_INDEX: "kg/m²",
  SLEEP_DURATION: "min",
};

function unitAndBandFor(type: string): {
  unit: string;
  referenceBand: { low: number; high: number } | null;
} {
  const meta = getMetricStatusMeta(type);
  if (meta) {
    return {
      unit: meta.unit,
      referenceBand: meta.normalRange
        ? { low: meta.normalRange.low, high: meta.normalRange.high }
        : null,
    };
  }
  return { unit: FALLBACK_UNITS[type] ?? "", referenceBand: null };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Reduce the full doctor-report payload to a compact, clinician-oriented,
 * grounded summary. The richer superset both surfaces share.
 */
export function summariseForVisit(
  data: DoctorReportData,
): Record<string, unknown> {
  const vitals = Object.entries(data.stats).map(([type, s]) => {
    const { unit, referenceBand } = unitAndBandFor(type);
    return {
      metric: type,
      unit,
      referenceBand,
      latest: round(s.latest),
      avg: round(s.avg),
      min: round(s.min),
      max: round(s.max),
      readings: s.count,
    };
  });

  const compliance = Object.entries(data.compliance).map(([name, c]) => ({
    medication: name,
    takenDoses: c.taken,
    expectedDoses: c.total,
    missedDoses: c.missed,
    adherencePct:
      c.total > 0 ? Math.min(100, Math.round((c.taken / c.total) * 100)) : null,
  }));

  const medications = data.medications
    .slice(0, 40)
    .map((m) => ({ name: m.name, dose: m.dose }));

  const labs = (data.labResults ?? []).slice(0, 50).map((l) => ({
    analyte: l.analyte,
    panel: l.panel,
    value: l.value,
    valueText: l.valueText,
    unit: l.unit,
    referenceLow: l.referenceLow,
    referenceHigh: l.referenceHigh,
    takenAt: l.takenAt,
    readings: l.count,
  }));

  const wellness = (data.wellnessScores ?? []).map((w) => ({
    score: w.type,
    latest: round(w.latest),
    avg: round(w.avg),
    note: "descriptive composite, not a clinical assessment",
  }));

  const illness = (data.illnessEpisodes ?? []).map((e) => ({
    label: e.label,
    type: e.type,
    lifecycle: e.lifecycle,
    onsetAt: e.onsetAt,
    resolvedAt: e.resolvedAt,
    // v1.39.2 — where on the body, in the person's own words, so fenced.
    ...(e.bodySite
      ? {
          bodySite: fenceUserText(e.bodySite),
          laterality: e.laterality ?? null,
        }
      : {}),
  }));

  // Absence is honest here too. An account whose owner never saved a report
  // selection resolves to the empty one on this surface, and an empty scope
  // produces an empty payload — which must read as "nothing was recorded for
  // this", not as a record with every section quietly missing. The
  // `{ present: false, reason }` sentinel is the same one the other MCP reads
  // use, so an assistant already knows how to read it.
  const hasContent =
    vitals.length > 0 ||
    medications.length > 0 ||
    compliance.length > 0 ||
    labs.length > 0 ||
    wellness.length > 0 ||
    illness.length > 0 ||
    data.mood != null ||
    data.bmi != null;
  if (!hasContent) {
    return {
      present: false,
      reason: "empty_report_selection",
      period: {
        days: data.period.days,
        start: data.period.start,
        end: data.period.end,
      },
    };
  }

  return {
    present: true,
    period: {
      days: data.period.days,
      start: data.period.start,
      end: data.period.end,
    },
    patient: {
      dateOfBirth: data.patient.dateOfBirth,
      sex: data.patient.gender,
      heightCm: data.patient.heightCm,
    },
    bmi: data.bmi,
    vitals,
    medications,
    compliance,
    // Mood is privacy-gated upstream; include only the aggregate when present.
    ...(data.mood
      ? {
          mood: {
            avg: round(data.mood.avg),
            min: data.mood.min,
            max: data.mood.max,
            entries: data.mood.count,
          },
        }
      : {}),
    // Glucose clinical panel only when the user logs glucose (stillLearning
    // flags a too-thin period — surfaced honestly, never asserted).
    ...(data.glucoseClinical && !data.glucoseClinical.stillLearning
      ? { glucosePanel: data.glucoseClinical }
      : {}),
    ...(labs.length > 0 ? { labs } : {}),
    ...(wellness.length > 0 ? { wellnessScores: wellness } : {}),
    ...(illness.length > 0 ? { illnessEpisodes: illness } : {}),
  };
}
