/**
 * The two `medications`-group leaves the clinician view never rendered: GLP-1
 * therapy and the logged-dose ledger.
 *
 * `MedicationsSection` in `./report-sections` covers the other two leaves of
 * the group (the drug list and the adherence rate); these sit beneath it.
 *
 * A pure server component: no client hooks, no session, no markdown — every
 * value renders as escaped React text.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { adherenceRatePercent } from "@/lib/doctor-report-data";
import { GLP1_SIDE_EFFECT_TAG_LABEL_KEYS } from "@/lib/medications/glp1-side-effect-tags";
import {
  LeafSection,
  StatRow,
  type LeafScope,
  type Translate,
} from "./report-sections";

/**
 * The most recent doses shown in full. The ledger itself is capped in the
 * hundreds or thousands (see `resolveMaxMedicationAdministrations`), which is
 * a reasonable size for a FHIR bundle a system files and an unreasonable one
 * for a page a person reads. Everything the cut hides is counted and named
 * rather than dropped silently.
 */
const DOSE_LOG_LIMIT = 20;

/**
 * GLP-1 therapy: the weight curve over the window, then per drug the current
 * dose, adherence and titration history, then the side-effect tally.
 *
 * Content and order follow the PDF's GLP-1 section. The tally is keyed by
 * `Glp1SideEffectTag` rather than by the string the mood entry was written
 * with, so the symptom is named in the reader's language and not in whichever
 * one it happened to be captured in.
 */
export function Glp1Section({
  t,
  report,
  scope,
  fmtDate,
  fmtNum,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  fmtDate: (iso: string) => string;
  fmtNum: (n: number) => string;
}) {
  const glp1 = report.glp1 ?? null;
  const medications = glp1?.medications ?? [];
  const sideEffects = glp1?.sideEffects ?? [];
  const weightLine =
    glp1 &&
    glp1.weightDeltaKg !== null &&
    glp1.weightStartKg !== null &&
    glp1.weightEndKg !== null
      ? t("doctorReport.glp1WeightSummary", {
          start: fmtNum(glp1.weightStartKg),
          end: fmtNum(glp1.weightEndKg),
          delta: fmtNum(glp1.weightDeltaKg),
        })
      : null;

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["GLP1_THERAPY"]}
      title={t("doctorReport.glp1Title")}
      empty={glp1 === null}
    >
      {weightLine ? <p className="mb-3 text-sm">{weightLine}</p> : null}
      <div className="space-y-4">
        {medications.map((med) => {
          const rate = adherenceRatePercent(
            med.compliance.taken,
            med.compliance.total,
          );
          return (
            <div
              key={med.name}
              className="border-border/60 rounded-md border px-3"
            >
              <StatRow
                label={med.name}
                value={
                  med.currentDose
                    ? t("doctorReport.glp1CurrentDose", {
                        value: fmtNum(med.currentDose.value),
                        unit: med.currentDose.unit,
                        since: fmtDate(med.currentDose.since),
                      })
                    : "—"
                }
                emphasise
              />
              {rate !== null ? (
                <StatRow
                  label={t("doctorReport.colComplianceRate")}
                  value={t("doctorReport.glp1Compliance", {
                    taken: med.compliance.taken,
                    total: med.compliance.total,
                    rate: Math.round(rate),
                  })}
                />
              ) : null}
              {med.doseHistory.map((change, index) => (
                <StatRow
                  key={`${change.effectiveFrom}-${index}`}
                  label={fmtDate(change.effectiveFrom)}
                  value={
                    `${fmtNum(change.value)} ${change.unit}` +
                    (change.note ? ` · ${change.note}` : "")
                  }
                />
              ))}
              {med.lastInjection ? (
                <StatRow
                  label={t("clinicianView.lastInjection")}
                  value={
                    fmtDate(med.lastInjection.date) +
                    (med.lastInjection.site
                      ? ` · ${med.lastInjection.site}`
                      : "")
                  }
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {sideEffects.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold">
            {t("doctorReport.glp1SideEffectsTitle")}
          </h3>
          {sideEffects.map((effect) => (
            <StatRow
              key={effect.tag}
              label={t(GLP1_SIDE_EFFECT_TAG_LABEL_KEYS[effect.tag])}
              value={String(effect.count)}
            />
          ))}
        </div>
      ) : null}
    </LeafSection>
  );
}

/**
 * The logged-dose ledger — every intake the person actually actioned over the
 * window, taken or deliberately skipped. Pending and missed rows are excluded
 * upstream, so nothing here asserts an administration that did not happen.
 *
 * This leaf reached the FHIR download and neither the page nor the PDF, which
 * made "Every logged dose" the one control on the picker whose effect a person
 * could only see by opening the bundle in another program. It renders as the
 * most recent {@link DOSE_LOG_LIMIT} rows with an explicit count of what the
 * cut left out; a five-thousand-row table is not a thing anyone reads, and a
 * silent top-20 is the kind of half-answer this whole surface exists to stop.
 */
export function DoseLogSection({
  t,
  report,
  scope,
  fmtDateTime,
  fmtNum,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  fmtDateTime: (iso: string) => string;
  fmtNum: (n: number) => string;
}) {
  const administrations = report.medicationAdministrations ?? [];
  // Newest first: a clinician reads "when did they last take it", not "when
  // did the window open".
  const ordered = [...administrations].sort((a, b) =>
    b.effectiveAt.localeCompare(a.effectiveAt),
  );
  const shown = ordered.slice(0, DOSE_LOG_LIMIT);
  // The aggregator's own cap may already have trimmed the set before it got
  // here; its `total` is the honest denominator when it did.
  const total =
    report.medicationAdministrationsTruncation?.total ?? ordered.length;

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["MEDICATION_ADMINISTRATIONS"]}
      title={t("clinicianView.doses.title")}
      empty={ordered.length === 0}
    >
      {shown.length < total ? (
        <p className="text-muted-foreground mb-3 text-xs">
          {t("clinicianView.doses.showing", {
            shown: shown.length,
            total,
          })}
        </p>
      ) : null}
      {shown.map((dose, index) => (
        <StatRow
          key={`${dose.medicationName}-${dose.effectiveAt}-${index}`}
          label={`${fmtDateTime(dose.effectiveAt)}: ${dose.medicationName}`}
          value={
            (dose.status === "completed"
              ? t("doctorReport.colTaken")
              : t("doctorReport.colSkipped")) +
            (dose.dose
              ? ` · ${fmtNum(dose.dose.value)} ${dose.dose.unit}`
              : dose.doseText
                ? ` · ${dose.doseText}`
                : "") +
            (dose.injectionSite ? ` · ${dose.injectionSite}` : "")
          }
        />
      ))}
    </LeafSection>
  );
}
