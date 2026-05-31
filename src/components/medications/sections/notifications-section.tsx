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
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

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
// v1.5.5 F-1 H-1 — split the title id so the section heading and
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
      const res = await fetch("/api/notifications/status");
      if (!res.ok) throw new Error("status_failed");
      return (await res.json()).data as NotificationStatusResponse;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });

  const { data: prefs } = useQuery<UserPrefsResponse>({
    queryKey: queryKeys.authMe(),
    queryFn: async () => {
      const res = await fetch("/api/auth/me");
      if (!res.ok) throw new Error("auth_failed");
      return (await res.json()).data as UserPrefsResponse;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });

  const clientManaged =
    prefs?.notificationPrefs?.medication?.clientManaged === true;

  async function flip(next: boolean) {
    if (submitting) return;
    setSubmitting(true);
    const previous = localEnabled;
    setLocalEnabled(next);
    try {
      const res = await fetch(`/api/medications/${medicationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationsEnabled: next }),
      });
      if (!res.ok) {
        setLocalEnabled(previous);
        toast.error(t("medications.detail.notifications.toggleFailed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(
        next
          ? t("medications.detail.notifications.enabledToast")
          : t("medications.detail.notifications.disabledToast"),
      );
    } catch {
      setLocalEnabled(previous);
      toast.error(t("medications.detail.notifications.toggleFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3" data-slot="medication-detail-notifications-body">
      {clientManaged ? (
        // v1.5.5 §9.6 — iPhone-managed path. The switch is hidden;
        // the read-only chip tells the user where the toggle lives.
        <p
          className="text-foreground text-sm"
          data-slot="notifications-client-managed-chip"
        >
          <Badge variant="outline" className="font-normal">
            {t("medications.detail.notifications.clientManagedChip")}
          </Badge>
        </p>
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

      {status && status.channels.length > 0 && (
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
