import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";

interface MedicationStateBadgesProps {
  notificationsEnabled: boolean;
  active: boolean;
  pausedAt: string | null;
  /** v1.39.1 (#1033) — intake tracking off: kept as a record only. */
  recordOnly?: boolean;
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
}: MedicationStateBadgesProps) {
  const { t } = useTranslations();

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
      {!notificationsEnabled && !recordOnly && (
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
