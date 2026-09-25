/**
 * The `labs` and `history` groups on the clinician view: lab results, illness
 * episodes, visits, the surgical history and the immunization record.
 *
 * All four were selectable on a share link and none of them reached the page,
 * while the PDF download from the same link printed every one. What each
 * section shows is taken from the PDF's tables — it has already settled what a
 * clinician expects in each and in what order — but a page is not a page of
 * paper, so a six-column table becomes a labelled block and a four-column one
 * becomes a row with its detail composed onto the value side.
 *
 * A pure server component: no client hooks, no session, no markdown — every
 * value renders as escaped React text.
 */
import type { EncounterKind, Laterality } from "@/generated/prisma/client";
import {
  encounterKindLabelKey,
  lateralityLabelKey,
} from "@/lib/encounters/kind-label";
import { formatReferenceRange } from "@/lib/labs/reference-range";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import {
  LeafSection,
  StatRow,
  type LeafScope,
  type Translate,
} from "./report-sections";

/** Join the parts of a composed value, dropping the ones with nothing in. */
function compose(parts: Array<string | null | undefined>): string {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" · ") : "—";
}

/**
 * Structured lab results over the window: one row per analyte, carrying the
 * latest reading, the reference window it was judged against, and the date.
 *
 * The PDF's neutral in/out-of-range glyph is deliberately not carried over.
 * On paper it sits in its own column beside the range; inline in a composed
 * value an arrow reads as an assertion about the reading rather than as a
 * column heading, and this page states what was recorded — it does not
 * adjudicate it.
 */
export function LabResultsSection({
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
  fmtNum: (n: number) => number;
}) {
  const results = report.labResults ?? [];

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["LAB_RESULTS"]}
      title={t("clinicianView.labs")}
      empty={results.length === 0}
    >
      {results.map((lab) => {
        // A qualitative reading ("negative") carries its result text and no
        // numeric range — the same split the PDF table makes.
        const qualitative = lab.value === null;
        const reading = qualitative
          ? lab.valueText
          : `${fmtNum(lab.value as number)} ${lab.unit}`.trim();
        const range = (low: number | null, high: number | null) =>
          formatReferenceRange(low, high, (value) => String(fmtNum(value)), {
            emptyText: "",
          });
        // The window the reading was judged against, printed as the source
        // report printed it when that is where it came from, so a clinician
        // comparing against the original reads the same characters.
        const reference = qualitative
          ? null
          : lab.referenceOrigin === "source" && lab.sourceReferenceText
            ? lab.sourceReferenceText
            : range(lab.referenceLow, lab.referenceHigh);
        // When the report's own window and the saved band disagree about the
        // same number, both are named. Showing one of two disagreeing windows
        // is a partial answer, and the PDF's footnote says so; here it fits on
        // the line rather than under a table.
        const catalog =
          !qualitative && lab.referenceDivergesFromCatalog
            ? range(lab.catalogReferenceLow, lab.catalogReferenceHigh)
            : "";
        return (
          <StatRow
            key={`${lab.panel ?? ""}-${lab.analyte}`}
            label={lab.panel ? `${lab.analyte} (${lab.panel})` : lab.analyte}
            value={compose([
              reading,
              reference
                ? `${t("doctorReport.labsColReference")} ${reference}` +
                  (catalog
                    ? ` (${t("doctorReport.labsCatalogRangeLabel")} ${catalog})`
                    : "")
                : null,
              fmtDate(lab.takenAt),
            ])}
          />
        );
      })}
    </LeafSection>
  );
}

/** Illness / condition episodes overlapping the window. */
export function IllnessSection({
  t,
  report,
  scope,
  fmtDate,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  fmtDate: (iso: string) => string;
}) {
  const episodes = report.illnessEpisodes ?? [];

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["ILLNESS_EPISODES"]}
      title={t("doctorReport.illnessTitle")}
      empty={episodes.length === 0}
    >
      {episodes.map((episode, index) => (
        <StatRow
          key={`${episode.label}-${episode.onsetAt}-${index}`}
          label={episode.label}
          value={compose([
            episode.bodySite
              ? episode.laterality
                ? t("encounters.bodySiteWithSide", {
                    site: episode.bodySite,
                    side: t(
                      lateralityLabelKey(episode.laterality as Laterality),
                    ),
                  })
                : episode.bodySite
              : null,
            t(`illness.type.${episode.type}`),
            t(`illness.lifecycle.${episode.lifecycle}`),
            `${fmtDate(episode.onsetAt)} – ${
              episode.resolvedAt
                ? fmtDate(episode.resolvedAt)
                : t("doctorReport.illnessOngoing")
            }`,
          ])}
        />
      ))}
    </LeafSection>
  );
}

/**
 * Visits inside the window. Six facts per visit is too many to compose onto
 * one line, so each visit is a bordered block of labelled rows — the shape
 * `AllergiesSection` already uses for the same reason.
 */
export function VisitsSection({
  t,
  report,
  scope,
  fmtDate,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  fmtDate: (iso: string) => string;
}) {
  const visits = report.visits ?? [];

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["VISITS"]}
      title={t("doctorReport.visitsTitle")}
      empty={visits.length === 0}
    >
      <div className="space-y-4">
        {visits.map((visit, index) => (
          <div
            key={`${visit.occurredAt}-${index}`}
            className="border-border/60 rounded-md border px-3"
          >
            <StatRow
              label={t("doctorReport.visitsColDate")}
              value={fmtDate(visit.occurredAt)}
            />
            <StatRow
              label={t("doctorReport.visitsColPractice")}
              value={compose([
                visit.practitionerName,
                visit.practitionerSpecialty,
              ])}
            />
            <StatRow
              label={t("doctorReport.visitsColKind")}
              value={t(encounterKindLabelKey(visit.kind as EncounterKind))}
            />
            <StatRow
              label={t("doctorReport.visitsColReason")}
              value={visit.reason ?? "—"}
            />
            <StatRow
              label={t("doctorReport.visitsColOutcome")}
              value={visit.outcome ?? "—"}
            />
            <StatRow
              label={t("doctorReport.visitsColConditions")}
              value={
                visit.conditionLabels.length > 0
                  ? visit.conditionLabels.join(", ")
                  : "—"
              }
            />
          </div>
        ))}
      </div>
    </LeafSection>
  );
}

/**
 * The surgical history. Reference data, not window-bounded, like the
 * immunization record below: every procedure that happened, oldest first. What
 * was done is the row's label; the date, the site with its side and the
 * outcome compose onto the value side, the shape the immunization rows use.
 */
export function SurgicalHistorySection({
  t,
  report,
  scope,
  fmtDate,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  fmtDate: (iso: string) => string;
}) {
  const procedures = report.surgicalHistory ?? [];

  const site = (row: (typeof procedures)[number]) => {
    if (!row.bodySite) return null;
    if (!row.laterality) return row.bodySite;
    return t("encounters.bodySiteWithSide", {
      site: row.bodySite,
      side: t(lateralityLabelKey(row.laterality as Laterality)),
    });
  };

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["SURGICAL_HISTORY"]}
      title={t("doctorReport.surgicalHistoryTitle")}
      empty={procedures.length === 0}
    >
      {procedures.map((row, index) => (
        <StatRow
          key={`${row.occurredAt}-${index}`}
          label={row.procedure ?? "—"}
          value={compose([fmtDate(row.occurredAt), site(row), row.outcome])}
        />
      ))}
    </LeafSection>
  );
}

/**
 * The immunization record. Reference data, not window-bounded: an Impfpass is
 * a lifetime document and the whole of it rides when the leaf and the module
 * admit it. No due-status and no gap analysis — the page reproduces the
 * record, it does not adjudicate it.
 */
export function ImmunizationsSection({
  t,
  report,
  scope,
  fmtDate,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  fmtDate: (iso: string) => string;
}) {
  const doses = report.immunizations ?? [];

  /** "3 of 4" / "Booster" / "Dose 2", from the server-resolved series. */
  const doseDisplay = (series: (typeof doses)[number]["series"]) => {
    const primary = series[0];
    if (!primary) return null;
    if (primary.booster) return t("vaccinations.series.booster");
    if (primary.total !== null) {
      return t("vaccinations.series.ofTotal", {
        position: primary.position,
        total: primary.total,
      });
    }
    return t("vaccinations.series.doseN", { position: primary.position });
  };

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["IMMUNIZATIONS"]}
      title={t("doctorReport.immunizationsTitle")}
      empty={doses.length === 0}
    >
      {doses.map((dose, index) => (
        <StatRow
          key={`${dose.occurredAt}-${index}`}
          label={
            dose.antigenSlug
              ? t(`vaccinations.catalog.${dose.antigenSlug}`)
              : (dose.vaccineName ?? "—")
          }
          value={compose([
            fmtDate(dose.occurredAt),
            doseDisplay(dose.series),
            dose.lotNumber
              ? `${t("doctorReport.immunizationsColLot")} ${dose.lotNumber}`
              : null,
          ])}
        />
      ))}
    </LeafSection>
  );
}
