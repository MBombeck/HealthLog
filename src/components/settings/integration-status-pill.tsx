"use client";

import { CheckCircle2, AlertTriangle, CircleSlash } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.4.19 phase A5 — single status pill rendered top-right of every
 * integration card (Withings, Mood Log, Apple Health…). It replaces
 * the three- to four-fold redundant status surface the maintainer spotted in
 * v1.4.18:
 *
 *   - top-right "Connected" badge
 *   - middle container with "Connected / last successful / last attempt"
 *   - bottom-of-card "letzter Sync" line
 *
 * Now there is exactly ONE place a sync status can appear on a card
 * and it follows the pattern the maintainer liked from the Withings header: a
 * Dracula-tokenized chip with the relative time inline.
 *
 * The component is locale-aware (EN + DE) and mobile-safe: on a
 * Pixel-5 viewport (393 CSS px) the pill stays on the same line as
 * the card title because it whitespace-nowraps and tucks the icon +
 * abbreviated time form into a 12 char string at most.
 */

export type IntegrationPillState =
  | "connected"
  | "warning"
  | "error"
  | "disconnected";

interface IntegrationStatusPillProps {
  state: IntegrationPillState;
  /** When connected, the last-successful-sync timestamp drives the
   *  relative "12 min ago" suffix. Pass `null` to suppress the
   *  suffix (used when the integration was just configured but has
   *  never synced yet). */
  lastSyncAt: Date | string | null;
  /** Override "now" for deterministic testing. Defaults to `new Date()`. */
  now?: Date;
  className?: string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Translate a millisecond delta into a short, locale-aware relative
 * string. We keep the buckets small and fixed (just-now / minutes /
 * hours / days) because the pill must fit on a 360 px wide card.
 */
function formatRelative(
  deltaMs: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (deltaMs < 60_000) return t("settings.integrationPill.justNow");
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return t("settings.integrationPill.minutesAgo", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t("settings.integrationPill.hoursAgo", { count: hours });
  }
  const days = Math.floor(hours / 24);
  return t("settings.integrationPill.daysAgo", { count: days });
}

export function IntegrationStatusPill({
  state,
  lastSyncAt,
  now,
  className,
}: IntegrationStatusPillProps) {
  const { t } = useTranslations();

  // chipClass only applies to the `connected` and `warning` branches —
  // `error` falls back to `variant="destructive"` and `disconnected` to
  // `variant="outline"`. The warning chip uses amber tokens to signal
  // "connected, but the upstream just returned a contract-level error
  // a reauth won't fix" — distinct from the red reconnect pill.
  const connectedChipClass =
    "border-dracula-green/30 bg-dracula-green/15 text-dracula-green";
  const warningChipClass =
    "border-dracula-yellow/30 bg-dracula-yellow/15 text-dracula-yellow";

  let label: string;
  let icon: React.ReactNode;

  switch (state) {
    case "connected":
      label = t("settings.integrationPill.connected");
      icon = <CheckCircle2 aria-hidden="true" className="h-3 w-3" />;
      break;
    case "warning":
      label = t("settings.integrationPill.warningServerError");
      icon = <AlertTriangle aria-hidden="true" className="h-3 w-3" />;
      break;
    case "error":
      label = t("settings.integrationPill.errorReconnect");
      icon = <AlertTriangle aria-hidden="true" className="h-3 w-3" />;
      break;
    case "disconnected":
      label = t("settings.integrationPill.notConnected");
      icon = <CircleSlash aria-hidden="true" className="h-3 w-3" />;
      break;
  }

  const reference = now ?? new Date();
  const relative =
    state === "connected" && lastSyncAt
      ? formatRelative(
          Math.max(0, reference.getTime() - toDate(lastSyncAt).getTime()),
          t,
        )
      : null;

  return (
    <Badge
      data-testid="integration-status-pill"
      data-state={state}
      variant={
        state === "connected" || state === "warning"
          ? undefined
          : state === "error"
            ? "destructive"
            : "outline"
      }
      aria-label={t("settings.integrationPill.ariaLabel")}
      className={cn(
        "max-w-full whitespace-nowrap",
        state === "connected" && connectedChipClass,
        state === "warning" && warningChipClass,
        className,
      )}
    >
      {icon}
      <span className="truncate">
        {label}
        {relative ? <span aria-hidden="true"> · {relative}</span> : null}
      </span>
      {relative ? <span className="sr-only">{relative}</span> : null}
    </Badge>
  );
}
