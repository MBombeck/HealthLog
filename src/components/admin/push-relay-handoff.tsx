"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { AdminPushRelayStatus } from "./use-push-relay";

/**
 * One figure of the read-out: its label on top and its value at the foot of
 * the cell, so the values of a row stay on one line when a label wraps in a
 * narrow column.
 */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * The hand-off time on the relay card: from queueing a push on this server
 * to the relay's answer, over the pushes the relay accepted in the window.
 * The median and the 95th percentile, how many pushes they are computed
 * over, and how many of those waited for a retry here. A window without an
 * accepted push says so in place of the figures.
 */
export function PushRelayHandoff({
  handoff,
}: {
  handoff: NonNullable<AdminPushRelayStatus["handoff"]>;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { windowHours: hours, count, p50Ms, p95Ms, retried } = handoff;

  // Whole milliseconds below a second, seconds with one decimal from there.
  const duration = (ms: number) =>
    ms < 1000
      ? t("admin.pushRelay.handoff.milliseconds", { value: fmt.integer(ms) })
      : t("admin.pushRelay.handoff.seconds", {
          value: fmt.number(ms / 1000, 1),
        });

  return (
    <div className="space-y-1 text-xs" data-slot="push-relay-handoff">
      <p className="font-medium">
        {t("admin.pushRelay.handoff.title", { hours })}
      </p>
      {p50Ms === null || p95Ms === null ? (
        <p>{t("admin.pushRelay.handoff.empty", { hours })}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
          <Figure
            label={t("admin.pushRelay.handoff.median")}
            value={duration(p50Ms)}
          />
          <Figure
            label={t("admin.pushRelay.handoff.p95")}
            value={duration(p95Ms)}
          />
          <Figure
            label={t("admin.pushRelay.handoff.pushes")}
            value={fmt.integer(count)}
          />
          {retried > 0 && (
            <Figure
              label={t("admin.pushRelay.handoff.retried")}
              value={fmt.integer(retried)}
            />
          )}
        </dl>
      )}
      <p className="text-muted-foreground">
        {t("admin.pushRelay.handoff.helper")}
      </p>
    </div>
  );
}
