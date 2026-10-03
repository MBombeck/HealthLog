import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { formatDate } from "@/lib/date-format";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";

interface MedicationStateBadgesProps {
  notificationsEnabled: boolean;
  active: boolean;
  pausedAt: string | null;
  /** v1.39.1 (#1033) — intake tracking off: kept as a record only. */
  recordOnly?: boolean;
  /** v1.39.4 (#1040) — the course's end date has passed. */
  courseEnded?: boolean;
  /**
   * v1.40 (#1024) — the server's `previousCourseEndedOn`: an ended course
   * names its last day ("Last course ended 16 Jun").
   */
  lastCourseEndedOn?: string | null;
  /** v1.40 (#1024) — the running course's number, when there are several. */
  courseNumber?: number | null;
}

/**
 * Shared "without notification" / "inactive" / "paused since …" badge pair
 * rendered in the medication-card header. Extracted from the generic and
 * GLP-1 cards so the two variants stay structurally symmetric instead of
 * hand-synced.
 */
export function MedicationStateBadges({
  notificationsEnabled,
  active,
  pausedAt,
  recordOnly = false,
  courseEnded = false,
  lastCourseEndedOn = null,
  courseNumber = null,
}: MedicationStateBadgesProps) {
  const { t, locale } = useTranslations();
  const dateFormatPref = useDateFormatPreference();

  return (
    <>
      {recordOnly && (
        <Badge
          variant="secondary"
          className="text-xs"
          data-slot="medication-record-only-badge"
        >
          {t("medications.recordOnlyBadge")}
        </Badge>
      )}
      {courseEnded && (
        <Badge
          variant="secondary"
          className="text-xs"
          data-slot="medication-course-ended-badge"
        >
          {lastCourseEndedOn
            ? t("medications.course.endedOn", {
                date: formatDate(
                  new Date(lastCourseEndedOn),
                  dateFormatPref,
                  locale,
                ),
              })
            : t("medications.courseEndedBadge")}
        </Badge>
      )}
      {!courseEnded && courseNumber !== null && (
        <Badge
          variant="secondary"
          className="text-xs"
          data-slot="medication-course-number-badge"
        >
          {t("medications.course.nth", { n: courseNumber })}
        </Badge>
      )}
      {!notificationsEnabled && !recordOnly && !courseEnded && (
        <Badge variant="secondary" className="text-xs">
          {t("medications.withoutNotification")}
        </Badge>
      )}
      {!active && (
        <Badge variant="secondary" className="text-xs">
          {pausedAt
            ? `${t("medications.pausedSince")} ${formatDateTime(pausedAt)}`
            : t("medications.inactive")}
        </Badge>
      )}
    </>
  );
}
