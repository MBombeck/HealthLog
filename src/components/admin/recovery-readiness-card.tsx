"use client";

/**
 * `<RecoveryReadinessCard>` — every backup signal on one card: the database
 * dump, the weekly account copies, the off-host copies, the last restore
 * drill, the off-host setup, the bucket's rule for the dumps and the recovery
 * kit. Each row says its verdict,
 * the time it is about and where to fix it.
 *
 * No time window anywhere: a failed drill stays on this card until a later
 * drill passes, where the failing-jobs card forgot it after 72 hours. The
 * verdicts are the server's (`src/lib/recovery/readiness-model.ts`), the same
 * ones the hourly evaluation pushes to every admin, so the card and the push
 * cannot disagree.
 *
 * Shown on the admin overview and on the Backups page. A row whose fix lives
 * on the page already open carries no link to itself.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  LifeBuoy,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";

import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Badge } from "@/components/ui/badge";
import { InlineAction } from "@/components/ui/inline-action";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import {
  useRecoveryReadiness,
  type ReadinessSignal,
  type ReadinessState,
  type RecoveryReadiness,
} from "./use-recovery-readiness";

const STATE_ICON: Record<
  ReadinessState,
  React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  ok: CheckCircle2,
  attention: AlertTriangle,
  failing: XCircle,
  inactive: MinusCircle,
};

const STATE_TONE: Record<ReadinessState, string> = {
  ok: "text-success",
  attention: "text-warning",
  failing: "text-destructive",
  inactive: "text-muted-foreground",
};

/** A grace period is ok for the verdict, but still a step for the admin. */
const isGrace = (signal: ReadinessSignal) => signal.reason.endsWith("_grace");

function OverallBadge({
  state,
}: {
  state: Exclude<ReadinessState, "inactive">;
}) {
  const { t } = useTranslations();
  const label = {
    ok: t("admin.recoveryReadiness.state.ok"),
    attention: t("admin.recoveryReadiness.state.attention"),
    failing: t("admin.recoveryReadiness.state.failing"),
  }[state];
  return (
    <Badge
      variant="outline"
      data-testid="recovery-readiness-state"
      data-state={state}
      className={cn(
        state === "attention" && "border-warning/40 text-warning",
        state === "failing" && "border-destructive/40 text-destructive",
      )}
    >
      {label}
    </Badge>
  );
}

function SignalRow({
  signal,
  currentPath,
}: {
  signal: ReadinessSignal;
  currentPath: string | null;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const grace = isGrace(signal);
  const Icon = grace ? Clock : STATE_ICON[signal.state];
  const tone = grace ? "text-info" : STATE_TONE[signal.state];
  const date = signal.at ? fmt.dateTime(new Date(signal.at)) : null;
  const showFix =
    signal.state !== "inactive" &&
    (signal.state !== "ok" || grace) &&
    signal.fixPath !== currentPath;

  return (
    <li
      className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
      data-testid={`recovery-signal-${signal.id}`}
      data-state={signal.state}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">
          {t(`admin.recoveryReadiness.signal.${signal.id}`)}
        </p>
        <p className="text-sm">
          {t(
            `admin.recoveryReadiness.reason.${signal.id}.${signal.reason}`,
            signal.params,
          )}
        </p>
        {date ? (
          <p className="text-muted-foreground text-xs">
            {grace
              ? t("admin.recoveryReadiness.dueBy", { date })
              : t(`admin.recoveryReadiness.at.${signal.id}`, { date })}
          </p>
        ) : null}
        {signal.detail && signal.state !== "ok" ? (
          <p className="text-muted-foreground text-xs break-words">
            {signal.detail}
          </p>
        ) : null}
      </div>
      {showFix ? (
        <InlineAction asChild size="sm" className="shrink-0 font-medium">
          <Link href={signal.fixPath}>
            {t(`admin.recoveryReadiness.fix.${signal.id}`)}
          </Link>
        </InlineAction>
      ) : null}
    </li>
  );
}

/** The list itself, for a readiness that has loaded. */
export function RecoveryReadinessList({
  readiness,
  currentPath,
}: {
  readiness: RecoveryReadiness;
  currentPath: string | null;
}) {
  return (
    <ul className="divide-border divide-y" data-testid="recovery-readiness">
      {readiness.signals.map((signal) => (
        <SignalRow key={signal.id} signal={signal} currentPath={currentPath} />
      ))}
    </ul>
  );
}

export function RecoveryReadinessCard() {
  const { t } = useTranslations();
  const currentPath = usePathname();
  const { data, isError, error, refetch } = useRecoveryReadiness();

  return (
    <SettingsCard
      as="section"
      aria-labelledby="recovery-readiness-heading"
      data-testid="recovery-readiness-card"
    >
      <SettingsCardHeader
        icon={LifeBuoy}
        titleId="recovery-readiness-heading"
        title={t("admin.recoveryReadiness.title")}
        description={t("admin.recoveryReadiness.description")}
        status={data ? <OverallBadge state={data.state} /> : null}
      />
      {data ? (
        <RecoveryReadinessList readiness={data} currentPath={currentPath} />
      ) : isError ? (
        <QueryErrorRow
          inset
          error={error}
          message={t("admin.recoveryReadiness.loadError")}
          onRetry={() => void refetch()}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Loader2
            className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="text-muted-foreground text-sm">
            {t("admin.recoveryReadiness.loading")}
          </span>
        </div>
      )}
    </SettingsCard>
  );
}
