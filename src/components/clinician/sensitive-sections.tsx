/**
 * The `sensitive` group on the clinician view: family history, mood and the
 * menstrual cycle.
 *
 * These are the leaves the catalogue fences in the picker — no group checkbox,
 * never in the shipped template, so no single control can switch on more than
 * one of them at a time. That fence is about how they are CHOSEN. Once one is
 * on a link the owner chose it deliberately and named it, so it renders as an
 * ordinary card, exactly as the health-profile leaf beside it already does and
 * exactly as the PDF prints them. A second fence at render would read as the
 * page second-guessing a decision the person already made.
 *
 * The fourth leaf of the group, `ANAMNESIS`, lives in `./report-sections`
 * because it was the one that was already rendered.
 *
 * A pure server component: no client hooks, no session, no markdown — every
 * value renders as escaped React text.
 */
import { pregnancyReportLines } from "@/lib/doctor-report-pdf/pregnancy-lines";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import {
  LeafSection,
  StatRow,
  type LeafScope,
  type Translate,
} from "./report-sections";

/** Display label per mood score. Mirrors the PDF's distribution table. */
const MOOD_LABEL_KEYS: Record<number, string> = {
  1: "doctorReport.moodAwful",
  2: "doctorReport.moodBad",
  3: "doctorReport.moodNeutral",
  4: "doctorReport.moodGood",
  5: "doctorReport.moodGreat",
};

/**
 * Family history: relationship, condition and age at onset. Third-party
 * information about people who consented to nothing, which is why it is fenced
 * in the picker; the free-text note is never read on this path.
 */
export function FamilyHistorySection({
  t,
  report,
  scope,
}: {
  t: Translate;
  report: DoctorReportData;
  scope: LeafScope;
}) {
  const entries = report.familyHistory ?? [];

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["FAMILY_HISTORY"]}
      title={t("doctorReport.familyHistoryTitle")}
      empty={entries.length === 0}
    >
      {entries.map((entry, index) => (
        <StatRow
          key={`${entry.relationship}-${entry.condition}-${index}`}
          label={t(`records.family.relationship.${entry.relationship}`)}
          value={
            entry.ageAtOnset !== null
              ? `${entry.condition} · ${t(
                  "doctorReport.familyHistoryColAgeAtOnset",
                )} ${entry.ageAtOnset}`
              : entry.condition
          }
        />
      ))}
    </LeafSection>
  );
}

/**
 * Mood over the window: the summary line the PDF prints, then the distribution
 * across the five scores. Counts and scores only — no journal text has ever
 * reached this payload, and the aggregator does not even select the note
 * columns.
 */
export function MoodSection({
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
  const mood = report.mood ?? null;
  const buckets = mood ? Object.entries(mood.distribution) : [];

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["MOOD"]}
      title={t("doctorReport.moodTitle")}
      empty={mood === null}
    >
      {mood ? (
        <p className="mb-3 text-sm">
          {t("doctorReport.moodSummary", {
            avg: fmtNum(mood.avg),
            count: mood.count,
            min: fmtNum(mood.min),
            max: fmtNum(mood.max),
          })}
        </p>
      ) : null}
      {buckets.map(([score, count]) => (
        <StatRow
          key={score}
          label={t(
            MOOD_LABEL_KEYS[Number(score)] ?? "doctorReport.moodNeutral",
          )}
          value={
            mood && mood.count > 0
              ? `${count} · ${fmtNum((count / mood.count) * 100)}%`
              : String(count)
          }
        />
      ))}
    </LeafSection>
  );
}

/**
 * The menstrual-cycle summary: last period, average length with its
 * variability, average period length, current phase, then the observed cycles.
 * Statistics only — no free-text note ever reaches this surface.
 */
export function CycleSection({
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
  const cycle = report.cycle ?? null;
  // The summary carries plain dates (YYYY-MM-DD); midday keeps the rendered
  // day from sliding a day either way in the owner's zone.
  const day = (date: string) => fmtDate(`${date}T12:00:00.000Z`);
  const days = t("doctorReport.cycleDays");

  const rows: Array<{ label: string; value: string }> = [];
  if (cycle?.lastPeriodStart) {
    rows.push({
      label: t("doctorReport.cycleLmp"),
      value: day(cycle.lastPeriodStart),
    });
  }
  if (cycle && cycle.averageCycleLengthDays !== null) {
    rows.push({
      label: t("doctorReport.cycleAvgLength"),
      value:
        `${fmtNum(cycle.averageCycleLengthDays)} ${days}` +
        (cycle.cycleLengthVariabilityDays !== null
          ? ` (± ${fmtNum(cycle.cycleLengthVariabilityDays)})`
          : ""),
    });
  }
  if (cycle && cycle.averagePeriodLengthDays !== null) {
    rows.push({
      label: t("doctorReport.cycleAvgPeriod"),
      value: `${fmtNum(cycle.averagePeriodLengthDays)} ${days}`,
    });
  }
  if (cycle?.currentPhase) {
    rows.push({
      label: t("doctorReport.cyclePhase"),
      value: t(`doctorReport.cyclePhases.${cycle.currentPhase}`),
    });
  }
  // The pregnancy or postpartum state on the report date, in the
  // PDF's own words (`pregnancyReportLines`).
  if (cycle?.pregnancy) {
    rows.push({
      label: t("doctorReport.pregnancy.title"),
      value: pregnancyReportLines(cycle.pregnancy, t, fmtDate).join(". "),
    });
  }

  return (
    <LeafSection
      t={t}
      scope={scope}
      leaves={["CYCLE"]}
      title={t("doctorReport.cycleTitle")}
      empty={cycle === null}
    >
      {rows.map((row) => (
        <StatRow key={row.label} label={row.label} value={row.value} />
      ))}
      {(cycle?.recentCycles ?? []).map((observed) => (
        <StatRow
          key={observed.startDate}
          label={`${t("doctorReport.cycleColStart")} ${day(observed.startDate)}`}
          value={[
            observed.lengthDays !== null
              ? `${t("doctorReport.cycleColLength")} ${observed.lengthDays}`
              : null,
            observed.periodLengthDays !== null
              ? `${t("doctorReport.cycleColPeriod")} ${observed.periodLengthDays}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
    </LeafSection>
  );
}
