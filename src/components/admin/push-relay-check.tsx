"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { AdminPushRelayStatus } from "./use-push-relay";

/** The reasons of a non-ok relay state the admin is told about in words. */
const STATE_REASON_LABEL = {
  bad_signature: "admin.pushRelay.stateReason.badSignature",
  relay_degraded: "admin.pushRelay.stateReason.relayDegraded",
  relay_maintenance: "admin.pushRelay.stateReason.relayMaintenance",
  relay_misconfigured: "admin.pushRelay.stateReason.relayMisconfigured",
} as const;

const CHECK_STATE_LABEL = {
  ok: "admin.pushRelay.check.state.ok",
  degraded: "admin.pushRelay.check.state.degraded",
  maintenance: "admin.pushRelay.check.state.maintenance",
  misconfigured: "admin.pushRelay.check.state.misconfigured",
} as const;

const NOTICE_LEVEL_LABEL = {
  info: "admin.pushRelay.noticeLevel.info",
  planned: "admin.pushRelay.noticeLevel.planned",
  action_required: "admin.pushRelay.noticeLevel.actionRequired",
} as const;

function labelOf<T extends Record<string, string>>(
  map: T,
  key: string | null | undefined,
): T[keyof T] | undefined {
  return key && Object.hasOwn(map, key) ? map[key as keyof T] : undefined;
}

/**
 * What the relay itself says that the admin should act on or know, in view
 * on the relay card of a registered instance: why the state is not `ok` when
 * the reason is one the admin can read (a refused signature, the relay's own
 * disruption), and the relay's current notice.
 */
export function PushRelayAlerts({ status }: { status: AdminPushRelayStatus }) {
  const { t } = useTranslations();
  if (!status.offered || !status.instanceId) return null;
  const reasonKey =
    status.state !== "ok"
      ? labelOf(STATE_REASON_LABEL, status.reason)
      : undefined;
  const notice = status.notice;
  const levelKey = labelOf(NOTICE_LEVEL_LABEL, notice?.level);
  if (!reasonKey && !notice) return null;
  return (
    <div className="space-y-1" data-slot="push-relay-check">
      {reasonKey && (
        <p className="text-sm" data-slot="push-relay-state-reason">
          {t(reasonKey)}
        </p>
      )}
      {notice && (
        <p className="text-sm" data-slot="push-relay-notice">
          {t("admin.pushRelay.notice", {
            id: notice.id,
            level: levelKey ? t(levelKey) : (notice.level ?? ""),
          })}
        </p>
      )}
    </div>
  );
}

/**
 * The relay's last hourly status check, with this instance's bindings at the
 * relay, among the delivery details.
 */
export function PushRelayCheckLine({
  status,
}: {
  status: AdminPushRelayStatus;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (!status.offered || !status.instanceId) return null;
  const check = status.relayCheck ?? null;
  const checkState = labelOf(CHECK_STATE_LABEL, check?.state);
  if (check?.answeredAt && checkState) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-slot="push-relay-check-line"
      >
        {t("admin.pushRelay.check.line", {
          time: fmt.dateTime(check.answeredAt),
          state: t(checkState),
        })}
        {check.devices
          ? ` ${t("admin.pushRelay.check.devices", {
              active: check.devices.active,
              provisional: check.devices.provisional,
              limit: check.devices.limit,
            })}`
          : ""}
      </p>
    );
  }
  if (check && !check.answeredAt && check.checkedAt) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-slot="push-relay-check-line"
      >
        {t("admin.pushRelay.check.unanswered", {
          time: fmt.dateTime(check.checkedAt),
        })}
      </p>
    );
  }
  return null;
}
