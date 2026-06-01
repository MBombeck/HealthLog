import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";

interface MedicationStateBadgesProps {
  notificationsEnabled: boolean;
  active: boolean;
  pausedAt: string | null;
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
}: MedicationStateBadgesProps) {
  const { t } = useTranslations();

  return (
    <>
      {!notificationsEnabled && (
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
