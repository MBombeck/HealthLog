/**
 * The health sections of the clinician view, grouped the way the owner chose
 * them, plus the leaf primitives every other section file on this surface is
 * built from.
 *
 * The measurement list used to be a flat `Object.entries(report.stats)` with a
 * humanised-enum fallback for any type the ten-entry label map missed, so a
 * clinician read rows called "Phq9 score" and "Audio exposure headphone" in
 * one undifferentiated column. It now renders in the same twelve groups the
 * selection panel shows, with the real localised labels, so the page and the
 * PDF describe the record in the same order.
 *
 * A pure server component: no client hooks, no session, no markdown — every
 * value renders as escaped React text.
 */
import { Fragment } from "react";

import { dateOnlyAtNoonUtc } from "@/lib/tz/date-only";
import type { MeasurementType } from "@/generated/prisma/client";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import {
  reportStatUnit,
  reportStatValue,
} from "@/lib/doctor-report/stat-display";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import {
  isReportLeafId,
  isStructuredLeafId,
  REPORT_GROUPS,
  type ReportLeafId,
} from "@/lib/report-selection/catalogue";
import type { ReportSelection } from "@/lib/report-selection/selection";

export type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * The two questions every section on this page asks about a leaf, resolved
 * once by {@link ClinicianView} and threaded down.
 *
 * `admits` is the link's own frozen scope. `unavailable` is the OWNER's module
 * map — a leaf they did share, in a domain their account has switched off.
 * They are separate because the recipient must be able to tell the resulting
 * blank sections apart, and the aggregator cannot: it ANDs the two gates and
 * returns the same nothing either way.
 */
export interface LeafScope {
  /** Whether the link's frozen selection carries this leaf. */
  admits(leaf: ReportLeafId): boolean;
  /** Whether the owner's module switch refuses it despite the selection. */
  unavailable(leaf: ReportLeafId): boolean;
}

/** Build the scope the sections read from the two things the page holds. */
export function makeLeafScope(
  selection: ReportSelection,
  unavailableLeaves: readonly ReportLeafId[],
): LeafScope {
  const blocked = new Set<ReportLeafId>(unavailableLeaves);
  return {
    admits: (leaf) => selection.has(leaf),
    unavailable: (leaf) => blocked.has(leaf),
  };
}

/** Human-readable display per persisted wellness-score type (i18n key suffix). */
const WELLNESS_KEY: Record<string, string> = {
  RECOVERY_SCORE: "recovery",
  STRESS_SCORE: "stress",
  STRAIN_SCORE: "strain",
};

/**
 * Render a single labelled stat row. `emphasise` lifts the weight of the value
 * for the two or three facts on the emergency card a reader must not have to
 * hunt for; it is weight only, never colour or alpha.
 */
export function StatRow({
  label,
  value,
  emphasise = false,
}: {
  label: string;
  value: string;
  emphasise?: boolean;
}) {
  return (
    <div className="border-border/40 flex items-baseline justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span
        className={
          emphasise
            ? "text-sm font-semibold tabular-nums"
            : "text-sm font-medium tabular-nums"
        }
      >
        {value}
      </span>
    </div>
  );
}

export function Section({
  title,
  leaves,
  children,
}: {
  title: string;
  /**
   * The catalogue leaves this card speaks for. Emitted as `data-leaf` so the
   * structural guard can prove the card is on the page, and so a reader
   * inspecting the markup can see which control produced it.
   */
  leaves?: readonly ReportLeafId[];
  children: React.ReactNode;
}) {
  return (
    <section
      data-leaf={leaves && leaves.length > 0 ? leaves.join(" ") : undefined}
      className="border-border bg-card rounded-lg border p-4 md:p-6"
    >
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A section for one or more catalogue leaves, carrying the three states the
 * recipient has to be able to tell apart:
 *
 *   - **not shared** — the link's frozen selection does not carry the leaf, so
 *     nothing renders at all. Silence is the honest answer: the recipient was
 *     never promised this part of the record and is owed no account of it.
 *   - **shared, switched off** — the leaf is on the link but the owner's
 *     account has the owning module off, so the aggregator never read it. The
 *     card renders with a line saying exactly that.
 *   - **shared, nothing recorded** — the leaf is on the link, the domain is
 *     live, and the window (or the record) holds nothing. The card renders
 *     with a line saying exactly that.
 *
 * A blank card is never allowed to stand for any of the three. This follows
 * `AnamnesisSection`, which has always printed "Not recorded" per fact rather
 * than collapsing, and extends it to the section level.
 *
 * The MEASUREMENT groups deliberately do NOT use this: a group card is a
 * container for up to seventeen leaves, and printing twelve empty group cards
 * for a link whose window happens to hold no readings is noise, not honesty.
 * There the group's own absence is legible from the cards that are present.
 */
export function LeafSection({
  t,
  scope,
  leaves,
  title,
  empty,
  children,
}: {
  t: Translate;
  scope: LeafScope;
  leaves: readonly ReportLeafId[];
  title: string;
  /** True when the admitted leaves produced no content to render. */
  empty: boolean;
  children: React.ReactNode;
}) {
  const admitted = leaves.filter((leaf) => scope.admits(leaf));
  if (admitted.length === 0) return null;

  // Every admitted leaf refused by its module ⇒ the card can carry nothing at
  // all. When only some are refused the rest still have data to show, and the
  // card says so by simply showing it.
  const unavailable = admitted.every((leaf) => scope.unavailable(leaf));

  return (
    <Section title={title} leaves={admitted}>
      {unavailable ? (
        <p className="text-muted-foreground text-sm">
          {t("clinicianView.sectionUnavailable")}
        </p>
      ) : empty ? (
        <p className="text-muted-foreground text-sm">
          {t("clinicianView.sectionEmpty")}
        </p>
      ) : (
        children
      )}
    </Section>
  );
}

/**
 * The measurement groups that carry data, in selection order. The aggregator
 * has already applied the selection; the scope is re-asked here anyway, so a
 * payload assembled by some future caller that forgot its gate still cannot
 * put a withheld reading in front of a recipient.
 */
export function MeasurementGroups({
  t,
  report,
  scope,
  fmtNum,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  fmtNum: (n: number) => string;
}) {
  const groups = REPORT_GROUPS.map((group) => ({
    labelKey: group.labelKey,
    rows: group.leaves
      .filter((leaf): leaf is MeasurementType => !isStructuredLeafId(leaf))
      .filter((leaf) => scope.admits(leaf))
      .map((type) => ({ type, stat: report.stats[type] }))
      .filter((row) => row.stat !== undefined && row.stat.count > 0),
  })).filter((group) => group.rows.length > 0);

  if (groups.length === 0) return null;

  // The same unit and the same number the PDF prints for the row: SI for
  // mass, length and temperature, the owner's unit for glucose, hours for
  // sleep. A clinician must never read a figure without knowing its unit.
  const glucoseUnit = resolveGlucoseUnit(report.glucoseUnit ?? null);
  const show = (type: string, value: number) =>
    fmtNum(reportStatValue(type, value, glucoseUnit));

  return (
    <>
      {groups.map((group) => (
        <Section
          key={group.labelKey}
          title={t(group.labelKey)}
          leaves={group.rows.map((row) => row.type)}
        >
          {group.rows.map(({ type, stat }) => (
            <StatRow
              key={type}
              label={t(MEASUREMENT_TYPE_LABEL_KEYS[type])}
              value={statSummary(t, reportStatUnit(type, glucoseUnit, t), {
                latest: show(type, stat!.latest),
                avg: show(type, stat!.avg),
                min: show(type, stat!.min),
                max: show(type, stat!.max),
              })}
            />
          ))}
        </Section>
      ))}
    </>
  );
}

/**
 * "latest 79 kg (avg 80 kg, range 78–82 kg)". A type with no unit (a score, a
 * count) keeps the unit-less sentence rather than printing a dangling space.
 */
function statSummary(
  t: Translate,
  unit: string,
  values: { latest: string; avg: string; min: string; max: string },
): string {
  return unit
    ? t("clinicianView.statSummaryWithUnit", { ...values, unit })
    : t("clinicianView.statSummary", values);
}

/**
 * Per-context glucose stats. The heading used to read "Lab values", which was
 * the wrong name for it even before the record's actual lab results reached
 * this page; it is the glucose group's own label now, and "Lab values" belongs
 * to the section that carries them.
 */
export function GlucoseSection({
  t,
  report,
  scope,
  fmtNum,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  fmtNum: (n: number) => string;
}) {
  const entries = Object.entries(report.glucoseStats).filter(
    ([, s]) => s.count > 0,
  );
  // Stored in mg/dL; shown in the record owner's unit, as the PDF shows it.
  const glucoseUnit = resolveGlucoseUnit(report.glucoseUnit ?? null);
  const show = (value: number) => fmtNum(convertGlucose(value, glucoseUnit));
  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["GLUCOSE_PANEL"]}
      title={t("reportSelection.groupGlucose")}
      empty={entries.length === 0}
    >
      {entries.map(([ctx, s]) => (
        <StatRow
          key={ctx}
          label={t(`clinicianView.glucose.${ctx}`)}
          value={statSummary(t, glucoseUnit, {
            latest: show(s.latest),
            avg: show(s.avg),
            min: show(s.min),
            max: show(s.max),
          })}
        />
      ))}
    </LeafSection>
  );
}

/** The medication list with the adherence rate beside each drug. */
/** A course day at noon UTC, so no viewer zone shifts it to a neighbour. */
function courseNoon(dayKey: string): string {
  return dateOnlyAtNoonUtc(dayKey).toISOString();
}

export function MedicationsSection({
  t,
  report,
  scope,
  fmtDate,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  /** Formats a calendar date for the viewer. */
  fmtDate: (iso: string) => string;
}) {
  const medications = scope.admits("MEDICATION_LIST")
    ? (report.medications ?? [])
    : [];
  const complianceOn = scope.admits("MEDICATION_COMPLIANCE");
  const complianceEntries = complianceOn
    ? Object.entries(report.compliance).filter(([, c]) => c.total > 0)
    : [];

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["MEDICATION_LIST", "MEDICATION_COMPLIANCE"]}
      title={t("clinicianView.medications")}
      empty={medications.length === 0 && complianceEntries.length === 0}
    >
      {medications.map((med) => {
        const comp = report.compliance[med.id];
        const rate =
          complianceOn && comp && comp.total > 0
            ? `${Math.round((comp.taken / comp.total) * 100)}%`
            : null;
        return (
          <Fragment key={med.id}>
            <StatRow
              label={med.dose ? `${med.name} ${med.dose}` : med.name}
              value={
                rate
                  ? t("clinicianView.adherence", { rate })
                  : t("clinicianView.noAdherence")
              }
            />
            {/* v1.40 (#1024) — one row per course inside the window. */}
            {(med.courses ?? []).map((course, index) => (
              <StatRow
                key={`${med.id}-course-${course.startsOn}`}
                label={t("clinicianView.course", { n: index + 1 })}
                value={
                  course.endsOn
                    ? t("clinicianView.courseRange", {
                        start: fmtDate(courseNoon(course.startsOn)),
                        end: fmtDate(courseNoon(course.endsOn)),
                      })
                    : t("clinicianView.courseSince", {
                        start: fmtDate(courseNoon(course.startsOn)),
                      })
                }
              />
            ))}
          </Fragment>
        );
      })}
      {complianceEntries
        .filter(([id]) => !medications.some((m) => m.id === id))
        .map(([id, c]) => (
          <StatRow
            key={id}
            label={c.name}
            value={t("clinicianView.adherence", {
              rate: `${Math.round((c.taken / c.total) * 100)}%`,
            })}
          />
        ))}
    </LeafSection>
  );
}

/** Structured allergy records, rendered only when the frozen scope allows it. */
export function AllergiesSection({
  t,
  report,
  scope,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
}) {
  const allergies = report.allergies ?? [];

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["ALLERGIES"]}
      title={t("doctorReport.allergiesTitle")}
      empty={allergies.length === 0}
    >
      <div className="space-y-4">
        {allergies.map((allergy, index) => (
          <div
            key={`${allergy.substance}-${allergy.category}-${allergy.type}-${index}`}
            className="border-border/60 rounded-md border px-3"
          >
            <StatRow
              label={t("doctorReport.allergiesColSubstance")}
              value={allergy.substance}
            />
            <StatRow
              label={t("doctorReport.allergiesColCategory")}
              value={t(`records.allergies.category.${allergy.category}`)}
            />
            <StatRow
              label={t("doctorReport.allergiesColKind")}
              value={t(`records.allergies.type.${allergy.type}`)}
            />
            <StatRow
              label={t("doctorReport.allergiesColSeverity")}
              value={
                allergy.severity
                  ? t(`records.allergies.severity.${allergy.severity}`)
                  : "—"
              }
            />
            <StatRow
              label={t("doctorReport.allergiesColReaction")}
              value={
                allergy.reactionUnreadable
                  ? t("doctorReport.reactionUnreadable")
                  : (allergy.reaction ?? "—")
              }
            />
            <StatRow
              label={t("doctorReport.allergiesColStatus")}
              value={t(`records.allergies.status.${allergy.status}`)}
            />
          </div>
        ))}
      </div>
    </LeafSection>
  );
}

/**
 * The selected health-profile leaf. It deliberately renders all four rows:
 * `not recorded` is different from a deselected leaf, while an unreadable
 * ciphertext is different from both.
 */
export function AnamnesisSection({
  t,
  report,
  scope,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
}) {
  const anamnesis = report.anamnesis ?? null;

  const absent = t("doctorReport.anamnesisNotRecorded");
  const unreadable = t("doctorReport.anamnesisUnreadable");
  const factValue = (
    kind: "SMOKING_STATUS" | "ALCOHOL_PATTERN" | "SHIFT_SCHEDULE",
    value: string | null,
  ): string => {
    if (anamnesis?.unreadableFacts.includes(kind)) return unreadable;
    return value ? t(`records.profileFacts.values.${kind}.${value}`) : absent;
  };

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["ANAMNESIS"]}
      title={t("doctorReport.anamnesisTitle")}
      empty={anamnesis === null}
    >
      <StatRow
        label={t("doctorReport.anamnesisConditions")}
        value={
          anamnesis?.conditionsUnreadable
            ? unreadable
            : (anamnesis?.conditions ?? absent)
        }
      />
      <StatRow
        label={t("doctorReport.anamnesisSmoking")}
        value={factValue("SMOKING_STATUS", anamnesis?.smokingStatus ?? null)}
      />
      <StatRow
        label={t("doctorReport.anamnesisAlcohol")}
        value={factValue("ALCOHOL_PATTERN", anamnesis?.alcoholPattern ?? null)}
      />
      <StatRow
        label={t("doctorReport.anamnesisShiftSchedule")}
        value={factValue("SHIFT_SCHEDULE", anamnesis?.shiftSchedule ?? null)}
      />
    </LeafSection>
  );
}

/**
 * The fenced wellness card. Descriptive composites, not clinical assessments —
 * the disclaimer is load-bearing and sits above the numbers, not under them.
 */
export function WellnessSection({
  t,
  report,
  scope,
  fmtNum,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
  fmtNum: (n: number) => string;
}) {
  const wellness =
    report.wellnessScores?.filter(
      (s) => s.count > 0 && isReportLeafId(s.type) && scope.admits(s.type),
    ) ?? [];
  // A measurement-backed card, so it collapses rather than printing an
  // absence line — see the note on `LeafSection`.
  if (wellness.length === 0) return null;
  return (
    <section
      data-leaf={wellness.map((s) => s.type).join(" ")}
      className="border-warning/50 bg-warning/5 rounded-lg border border-dashed p-4 md:p-6"
    >
      <h2 className="text-muted-foreground mb-1 text-base font-semibold">
        {t("clinicianView.wellness.title")}
      </h2>
      <p className="text-muted-foreground mb-3 text-xs">
        {t("clinicianView.wellness.disclaimer")}
      </p>
      <div>
        {wellness.map((s) => (
          <StatRow
            key={s.type}
            label={t(
              `clinicianView.wellness.${WELLNESS_KEY[s.type] ?? "score"}`,
            )}
            value={t("clinicianView.statSummary", {
              latest: fmtNum(s.latest),
              avg: fmtNum(s.avg),
              min: fmtNum(s.min),
              max: fmtNum(s.max),
            })}
          />
        ))}
      </div>
    </section>
  );
}
