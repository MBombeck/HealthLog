/**
 * The emergency card's rows (v1.49): each asked-for item as a label and its
 * lines, in the card's reading order. One wording for every rendering: the
 * phone view, the read-only link, the offline copy and the wallet card.
 *
 * Only items the card was asked for appear. An item asked for that holds
 * nothing reads "Not recorded", so a responder can tell an empty answer from
 * a question the owner chose not to share.
 */
import type { EmergencyCardAllergy, EmergencyCardView } from "./card-data";

export type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function formatCardDay(locale: string, day: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(`${day}T12:00:00Z`));
  } catch {
    return day;
  }
}

function allergyLine(t: Translate, a: EmergencyCardAllergy): string {
  const parts = [a.substance];
  if (a.severity) parts.push(t(`records.allergies.severity.${a.severity}`));
  if (a.reaction) parts.push(a.reaction);
  return parts.join(", ");
}

/** The pregnancy line, in the card's words. */
export function pregnancyLine(
  t: Translate,
  locale: string,
  p: NonNullable<EmergencyCardView["pregnancy"]>,
): string {
  if (p.state === "PREGNANT") {
    const head =
      p.gestationalWeeks !== null
        ? t("emergencyCard.pregnantWeek", {
            weeks: p.gestationalWeeks,
            days: p.gestationalDays ?? 0,
          })
        : t("emergencyCard.pregnant");
    return p.dueDate
      ? `${head}. ${t("emergencyCard.dueDate", { date: formatCardDay(locale, p.dueDate) })}`
      : head;
  }
  return p.deliveryDate
    ? t("emergencyCard.postpartum", {
        date: formatCardDay(locale, p.deliveryDate),
        weeks: p.postpartumWeek ?? 0,
      })
    : t("emergencyCard.postpartumNoDate");
}

/** One item as label and lines, or null when the card was not asked for it. */
export function emergencyCardRows(
  view: EmergencyCardView,
  t: Translate,
  locale: string,
): Array<{ key: string; label: string; lines: string[]; emphasise: boolean }> {
  const none = t("records.emergency.notRecorded");
  const rows: Array<{
    key: string;
    label: string;
    lines: string[];
    emphasise: boolean;
  }> = [];
  const push = (
    key: string,
    label: string,
    lines: string[] | null,
    emphasise = false,
  ) => {
    if (!view.fields.includes(key as EmergencyCardView["fields"][number])) {
      return;
    }
    rows.push({
      key,
      label,
      lines: lines && lines.length > 0 ? lines : [none],
      emphasise: emphasise && lines !== null && lines.length > 0,
    });
  };
  push(
    "BLOOD_TYPE",
    t("records.emergency.bloodType"),
    view.bloodType
      ? [t(`records.emergency.bloodTypeValues.${view.bloodType}`)]
      : null,
    true,
  );
  push(
    "ALLERGIES",
    t("emergencyCard.allergies"),
    view.allergies?.map((a) => allergyLine(t, a)) ?? null,
    true,
  );
  push(
    "CONDITIONS",
    t("doctorReport.emergency.chronicConditions"),
    view.conditions,
  );
  push(
    "MEDICATIONS",
    t("doctorReport.emergency.activeMedications"),
    view.medications?.map((m) => (m.dose ? `${m.name} ${m.dose}` : m.name)) ??
      null,
  );
  push(
    "PREGNANCY",
    t("emergencyCard.pregnancy"),
    view.pregnancy ? [pregnancyLine(t, locale, view.pregnancy)] : null,
    true,
  );
  push(
    "IMPLANTS",
    t("records.emergency.implants"),
    view.implants ? [view.implants] : null,
  );
  push(
    "CONTACTS",
    t("records.emergency.contacts"),
    view.contacts ? view.contacts.split("\n").filter(Boolean) : null,
    true,
  );
  push(
    "ADVANCE_DIRECTIVE",
    t("records.emergency.advanceDirective"),
    view.advanceDirective
      ? [t(`records.emergency.advanceDirectiveValues.${view.advanceDirective}`)]
      : null,
  );
  push(
    "ORGAN_DONOR",
    t("records.emergency.organDonor"),
    view.organDonor
      ? [t(`records.emergency.organDonorValues.${view.organDonor}`)]
      : null,
  );
  push("NOTE", t("records.emergency.note"), view.note ? [view.note] : null);
  push(
    "DATE_OF_BIRTH",
    t("emergencyCard.dateOfBirth"),
    view.dateOfBirth ? [formatCardDay(locale, view.dateOfBirth)] : null,
  );
  return rows;
}
