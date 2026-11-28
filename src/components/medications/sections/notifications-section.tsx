"use client";

/**
 * v1.5.5 D-3 §9.6 — Notifications section.
 *
 * One `SwitchRow`: the name is the switch's label, the helper line its
 * description. The switch flips
 * `medication.notificationsEnabled` via the parent route's
 * `PUT /api/medications/[id]` with `{ notificationsEnabled }`. State
 * persists optimistically — the parent cache update lands in the same
 * paint as the toast (E-4 C-1).
 *
 * When the user has opted in to `notificationPrefs.medication.clientManaged`
 * (the iOS-managed-reminders path) the switch is replaced by a
 * read-only chip `iPhone steuert die Erinnerungen`. The clientManaged
 * value rides on the `auth/me` user prefs read.
 *
 * The chip strip below the switch is decorative (`aria-hidden="true"`
 * per §10 invariant 12) and surfaces the global notification channels
 * the medication reminder will reach when enabled.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Badge } from "@/components/ui/badge";
import { SwitchRow } from "@/components/ui/switch-row";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { useAuth } from "@/hooks/use-auth";
import {
  useRecordCapabilities,
  holdsOwnerRights,
} from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import { apiGet, apiPut } from "@/lib/api/api-fetch";

export interface NotificationsSectionProps {
  medicationId: string;
  notificationsEnabled: boolean;
  /**
   * Doses are recorded automatically: no reminder is sent whatever the
   * switch says, and the helper says so instead of "Reminders are on".
   */
  autoMarkTaken?: boolean;
  /** What the reminders will do, in words (`ReminderPlanLine`). */
  plan?: React.ReactNode;
  /**
   * One line: the name and the switch (or the iPhone chip), no helper, no
   * plan, no channel chips. The settings tab's row.
   */
  compact?: boolean;
}

interface NotificationChannel {
  type: string;
  enabled?: boolean;
  status?: string;
}

interface NotificationStatusResponse {
  channels: NotificationChannel[];
}

interface UserPrefsResponse {
  notificationPrefs?: {
    medication?: { clientManaged?: boolean };
  };
}

const SWITCH_ID = "medication-detail-notifications-switch";
// The section heading carries its own id; the switch takes its name from
// the row's label, never from the heading, so the two never share an id.
const SECTION_TITLE_ID = "medication-detail-notifications-heading";

/**
 * v1.7.0 — section wrapper. Keeps the `<MedicationDetailSection>`
 * chrome for any standalone consumer; the advanced-settings sheet
 * consumes `<NotificationsBody>` directly under its own group header.
 */
export function NotificationsSection(props: NotificationsSectionProps) {
  const { t } = useTranslations();
  return (
    <MedicationDetailSection
      titleId={SECTION_TITLE_ID}
      title={t("medications.detail.notifications.title")}
      dataSlot="medication-detail-notifications-section"
    >
      <NotificationsBody {...props} />
    </MedicationDetailSection>
  );
}

export function NotificationsBody({
  medicationId,
  notificationsEnabled,
  autoMarkTaken = false,
  plan = null,
  compact = false,
}: NotificationsSectionProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  // #1408 — a managed profile's guardian reaches this switch (it writes the
  // record's medication), but both reads below describe the CALLER: their
  // delivery channels and their own iPhone opt-in. Inside somebody else's
  // record they are not this medication's facts, and the status route refuses
  // a switched session, so neither is asked there.
  // #1615 — the profile's guardian holds the owner's rights, so the two
  // reads answer for the profile there.
  const ownerRights = holdsOwnerRights(useRecordCapabilities());
  const readsCallerPrefs = isAuthenticated && ownerRights;
  const queryClient = useQueryClient();
  const [localEnabled, setLocalEnabled] = useState(notificationsEnabled);
  const [submitting, setSubmitting] = useState(false);

  // Dual-source read per §9.6 — the per-medication value lives on the
  // medication record, the global channel strip lives on the
  // notifications-status endpoint. Both feed the same section so the
  // user can confirm in one glance.
  const { data: status } = useQuery<NotificationStatusResponse>({
    queryKey: queryKeys.notificationsStatus(),
    queryFn: async () => {
      return apiGet<NotificationStatusResponse>("/api/notifications/status");
    },
    enabled: readsCallerPrefs,
    staleTime: 60_000,
  });

  const { data: prefs } = useQuery<UserPrefsResponse>({
    queryKey: queryKeys.authMe(),
    queryFn: async () => {
      return apiGet<UserPrefsResponse>("/api/auth/me");
    },
    enabled: readsCallerPrefs,
    staleTime: 60_000,
  });

  // Gated on the same flag, not only the queries: the `/me` cache cell is
  // shared with the rest of the app and may already hold the caller's row.
  const clientManaged =
    readsCallerPrefs &&
    prefs?.notificationPrefs?.medication?.clientManaged === true;

  async function flip(next: boolean) {
    if (submitting) return;
    setSubmitting(true);
    const previous = localEnabled;
    setLocalEnabled(next);
    try {
      await apiPut(`/api/medications/${medicationId}`, {
        notificationsEnabled: next,
      });
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(
        next
          ? t("medications.detail.notifications.enabledToast")
          : t("medications.detail.notifications.disabledToast"),
      );
    } catch (failure) {
      setLocalEnabled(previous);
      showErrorToast(t("medications.detail.notifications.toggleFailed"), {
        cause: failure,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className={compact ? undefined : "space-y-3"}
      data-slot="medication-detail-notifications-body"
    >
      {clientManaged ? (
        // v1.5.5 §9.6 — iPhone-managed path. The switch is hidden;
        // the read-only chip tells the user where the toggle lives.
        // The badge carries a short label only (a full sentence used to
        // hard-clip mid-word in the nowrap badge); the sentence moved to
        // the helper line below.
        <div
          className="space-y-1"
          data-slot="notifications-client-managed-chip"
        >
          {compact ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-foreground text-sm font-medium">
                {t("medications.detail.notifications.switchLabel")}
              </span>
              <Badge variant="outline" className="font-normal">
                {t("medications.detail.notifications.clientManagedChip")}
              </Badge>
            </div>
          ) : (
            <>
              <Badge variant="outline" className="font-normal">
                {t("medications.detail.notifications.clientManagedChip")}
              </Badge>
              <p className="text-muted-foreground text-sm">
                {t("medications.detail.notifications.clientManagedHint")}
              </p>
            </>
          )}
        </div>
      ) : (
        <SwitchRow
          label={t("medications.detail.notifications.switchLabel")}
          description={
            compact
              ? undefined
              : autoMarkTaken
                ? t("medications.detail.notifications.helperAutoRecorded")
                : localEnabled
                  ? t("medications.detail.notifications.helperOn")
                  : t("medications.detail.notifications.helperOff")
          }
          id={SWITCH_ID}
          checked={localEnabled}
          disabled={submitting}
          onCheckedChange={(checked) => void flip(checked)}
          data-slot="medication-notifications-switch"
        />
      )}

      {/* When the reminders come and when the dose counts as missed, read
          off the resolved next dose. */}
      {!compact && !autoMarkTaken && plan}

      {!compact &&
        readsCallerPrefs &&
        Array.isArray(status?.channels) &&
        status.channels.length > 0 && (
          <div
            className="flex flex-wrap gap-1.5"
            aria-hidden="true"
            data-slot="notifications-channels-chips"
          >
            {status.channels.map((channel) => (
              <Badge key={channel.type} variant="outline" className="text-xs">
                {channel.type}
              </Badge>
            ))}
          </div>
        )}
    </div>
  );
}
