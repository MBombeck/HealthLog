"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  XCircle,
} from "lucide-react";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { Badge } from "@/components/ui/badge";
import { InlineAction } from "@/components/ui/inline-action";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SETUP_HEALTH_SIGNALS,
  type SetupHealthSignal,
  type SetupHealthState,
} from "@/lib/admin/setup-health-model";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import { useServerSetup, useSetupHealth } from "@/lib/queries/use-server-setup";

const STATE_ICON: Record<
  SetupHealthState,
  React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  ok: CheckCircle2,
  attention: AlertTriangle,
  failing: XCircle,
};

const STATE_TONE: Record<SetupHealthState, string> = {
  ok: "text-success",
  attention: "text-warning",
  failing: "text-destructive",
};

function SignalRow({ signal }: { signal: SetupHealthSignal }) {
  const { t } = useTranslations();
  const Icon = STATE_ICON[signal.state];
  return (
    <li
      className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
      data-testid={`setup-health-${signal.id}`}
      data-state={signal.state}
    >
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", STATE_TONE[signal.state])}
        aria-hidden
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">
          {t(`admin.setupHealth.signal.${signal.id}`)}
        </p>
        <p className="text-sm break-words">
          {t(
            `admin.setupHealth.reason.${signal.id}.${signal.reason}`,
            signal.params,
          )}
        </p>
        {/* A row that is fine needs no way to fix it. */}
        {signal.state !== "ok" ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {signal.fixPath ? (
              <InlineAction asChild size="sm" className="font-medium">
                <Link href={signal.fixPath}>{t("admin.setupHealth.fix")}</Link>
              </InlineAction>
            ) : null}
            <InlineAction asChild size="sm" tone="muted">
              <a href={signal.docsUrl} target="_blank" rel="noreferrer">
                {t("admin.setupHealth.docs")}
              </a>
            </InlineAction>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * 1.49 — the setup health check list: encryption keys present, the
 * secure-cookie setting against how this page was reached, the database dump
 * schedule, the public URL. Read-only; each row links to where it is fixed.
 * On Admin → System status for good, and on the server setup's last step.
 */
export function SetupHealthCard({
  showSetupLink = true,
}: {
  /** The way back into the server setup; off inside the setup itself. */
  showSetupLink?: boolean;
}) {
  const { t } = useTranslations();
  const { data, isError, error, refetch } = useSetupHealth();
  const setup = useServerSetup({ enabled: showSetupLink });
  const label: Record<SetupHealthState, string> = {
    ok: t("admin.setupHealth.state.ok"),
    attention: t("admin.setupHealth.state.attention"),
    failing: t("admin.setupHealth.state.failing"),
  };

  return (
    <SettingsCard
      as="section"
      aria-labelledby="setup-health-heading"
      data-testid="setup-health-card"
    >
      <SettingsCardHeader
        icon={ClipboardCheck}
        titleId="setup-health-heading"
        title={t("admin.setupHealth.title")}
        description={t("admin.setupHealth.description")}
        status={
          data ? (
            <Badge
              variant="outline"
              data-testid="setup-health-state"
              data-state={data.state}
              className={cn(
                data.state === "attention" && "border-warning/40 text-warning",
                data.state === "failing" &&
                  "border-destructive/40 text-destructive",
              )}
            >
              {label[data.state]}
            </Badge>
          ) : null
        }
      />
      {data ? (
        <ul className="divide-border divide-y" data-testid="setup-health">
          {data.signals.map((signal) => (
            <SignalRow key={signal.id} signal={signal} />
          ))}
        </ul>
      ) : isError ? (
        <QueryErrorRow
          inset
          error={error}
          message={t("admin.setupHealth.loadError")}
          onRetry={() => void refetch()}
        />
      ) : (
        <ul className="divide-border divide-y" aria-hidden="true">
          {SETUP_HEALTH_SIGNALS.map((slot) => (
            <li
              key={slot}
              className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
            >
              <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1">
                <Skeleton className="h-5 w-40 max-w-full" />
                <Skeleton className="h-5 w-full" />
              </div>
            </li>
          ))}
        </ul>
      )}
      {showSetupLink && setup.data?.offered ? (
        <SettingsCardActions>
          <Button asChild variant="outline" size="sm">
            <Link href="/onboarding/server" data-slot="setup-health-open-setup">
              {t("admin.setupHealth.openSetup")}
            </Link>
          </Button>
        </SettingsCardActions>
      ) : null}
    </SettingsCard>
  );
}
