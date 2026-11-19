"use client";

/**
 * v1.5.5 D-3 §9.6 — Notifications section.
 *
 * Single Switch wrapped in a `<label>` so the entire row is the AT hit
 * target (H-cluster-H + §10 invariant 4). The switch flips
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
import Link from "next/link";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
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
// v1.5.5 — split the title id so the section heading and
// the inner switch label resolve to distinct DOM nodes. The earlier
// single `TITLE_ID` sat on both `<MedicationDetailSection>`'s heading
// (`titleId` prop) and the inner `<span>` carrying the switch's
// `aria-labelledby`, surfacing as an axe duplicate-id failure on
// every detail-page render and pointing the announced name at the
// section heading rather than the user's "Send a reminder" target.
const SECTION_TITLE_ID = "medication-detail-notifications-heading";
const ROW_TITLE_ID = "medication-detail-notifications-row-label";
const HELPER_ID = "medication-detail-notifications-helper";

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
}: NotificationsSectionProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  // #1408 — a managed profile's guardian reaches this switch (it writes the
  // record's medication), but both reads below describe the CALLER: their
  // delivery channels and their own iPhone opt-in. Inside somebody else's
  // record they are not this medication's facts, and the status route refuses
  // a switched session, so neither is asked there.
  const { inSharedRecord } = useRecordCapabilities();
  const readsCallerPrefs = isAuthenticated && !inSharedRecord;
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
    <div className="space-y-3" data-slot="medication-detail-notifications-body">
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
          <Badge variant="outline" className="font-normal">
            {t("medications.detail.notifications.clientManagedChip")}
          </Badge>
          <p className="text-muted-foreground text-sm">
            {t("medications.detail.notifications.clientManagedHint")}
          </p>
        </div>
      ) : (
        <label
          htmlFor={SWITCH_ID}
          className="flex items-center justify-between gap-3"
          data-slot="notifications-switch-row"
        >
          <span className="space-y-1">
            <span
              id={ROW_TITLE_ID}
              className="text-foreground block text-sm font-medium"
            >
              {t("medications.detail.notifications.switchLabel")}
            </span>
            <span
              id={HELPER_ID}
              className="text-muted-foreground block text-xs"
            >
              {localEnabled
                ? t("medications.detail.notifications.helperOn")
                : t("medications.detail.notifications.helperOff")}
            </span>
          </span>
          <Switch
            id={SWITCH_ID}
            checked={localEnabled}
            disabled={submitting}
            onCheckedChange={(checked) => void flip(checked)}
            aria-labelledby={ROW_TITLE_ID}
            aria-describedby={HELPER_ID}
          />
        </label>
      )}

      {readsCallerPrefs &&
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

/**
 * Quiet cross-link: WHICH channels deliver the reminder (push / Telegram /
 * ntfy, quiet hours) is configured globally, not per medication. Those are the
 * caller's own settings, so the page leaves it out of a shared record.
 */
export function ManageChannelsLink() {
  const { t } = useTranslations();
  return (
    <p className="text-muted-foreground text-xs">
      <Link
        href="/settings/notifications"
        className="focus-visible:ring-ring rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        data-slot="zeitplan-manage-channels-link"
      >
        {t("medications.detail.zeitplan.manageChannels")}
      </Link>
    </p>
  );
}
