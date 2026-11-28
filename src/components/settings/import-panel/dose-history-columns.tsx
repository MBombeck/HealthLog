"use client";

/**
 * What the dose-history importer does with every field of the export.
 *
 * Visible before a file is chosen, not discovered afterwards. A column read and
 * silently dropped is indistinguishable, from the outside, from a column read and
 * used — which is how a person ends up believing an importer honoured something
 * it never looked at.
 *
 * The rulings come from `AUTO_EXPORT_COLUMN_RULINGS`, so the parser and this list
 * cannot drift: a structural test asserts every column the format defines has
 * exactly one ruling, and the sentence for each ruling is a literal `t()` call
 * below so the i18n call-site guard sees all of them.
 */
import { AUTO_EXPORT_COLUMN_RULINGS } from "@/lib/medications/import/auto-export-format";
import { useTranslations } from "@/lib/i18n/context";

/** One literal `t()` per note key. A computed key would be invisible to the guard. */
function useColumnNote(): (noteKey: string) => string {
  const { t } = useTranslations();
  const notes: Record<string, string> = {
    date: t("settings.sections.export.import.doseHistory.column.date"),
    scheduledDate: t(
      "settings.sections.export.import.doseHistory.column.scheduledDate",
    ),
    medication: t(
      "settings.sections.export.import.doseHistory.column.medication",
    ),
    nickname: t("settings.sections.export.import.doseHistory.column.nickname"),
    dosage: t("settings.sections.export.import.doseHistory.column.dosage"),
    scheduledDosage: t(
      "settings.sections.export.import.doseHistory.column.scheduledDosage",
    ),
    unit: t("settings.sections.export.import.doseHistory.column.unit"),
    status: t("settings.sections.export.import.doseHistory.column.status"),
    archived: t("settings.sections.export.import.doseHistory.column.archived"),
    codings: t("settings.sections.export.import.doseHistory.column.codings"),
    form: t("settings.sections.export.import.doseHistory.column.form"),
    start: t("settings.sections.export.import.doseHistory.column.start"),
    end: t("settings.sections.export.import.doseHistory.column.end"),
  };
  return (noteKey: string) => notes[noteKey] ?? "";
}

function useVerdictLabel(): (verdict: string) => string {
  const { t } = useTranslations();
  const labels: Record<string, string> = {
    honoured: t("settings.sections.export.import.doseHistory.verdict.honoured"),
    reported: t("settings.sections.export.import.doseHistory.verdict.reported"),
    ignored: t("settings.sections.export.import.doseHistory.verdict.ignored"),
  };
  return (verdict: string) => labels[verdict] ?? verdict;
}

/** Every column of the export and what the importer does with it. */
export function DoseHistoryColumnRulings() {
  const { t } = useTranslations();
  const noteFor = useColumnNote();
  const verdictFor = useVerdictLabel();

  return (
    <dl className="space-y-2" data-testid="dose-history-columns">
      {AUTO_EXPORT_COLUMN_RULINGS.map((ruling) => (
        <div key={ruling.column} data-testid="dose-history-column-ruling">
          <dt className="text-foreground flex flex-wrap items-baseline gap-x-2 text-xs">
            <code className="font-mono">{ruling.column}</code>
            <span
              className="text-muted-foreground text-2xs uppercase"
              data-verdict={ruling.verdict}
            >
              {verdictFor(ruling.verdict)}
            </span>
            {ruling.jsonOnly && (
              <span className="text-muted-foreground text-2xs">
                {t("settings.sections.export.import.doseHistory.jsonOnly")}
              </span>
            )}
          </dt>
          <dd className="text-muted-foreground text-xs">
            {noteFor(ruling.noteKey)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
