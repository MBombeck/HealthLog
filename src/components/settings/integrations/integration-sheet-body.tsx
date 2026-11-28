"use client";

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Link2, Play, RefreshCw } from "lucide-react";

import type { IntegrationSheetSlots } from "@/components/settings/sheet-surface";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import {
  APP_VERSION,
  DetailsPanel,
  IntegrationMenu,
  PrimaryButton,
} from "./integration-card-parts";
import type { IntegrationCardProps } from "./integration-card";
import {
  diagnosticsText,
  unavailableItemLabel,
} from "./integration-health-copy";

/**
 * The card as the body of an integration sheet. The sheet already names the
 * connection and shows its status, reason and last sync, so the body keeps
 * what the person can do: the setup forms (open, not folded), the lines a
 * controller adds, the bug-report details, and the action pair at the foot.
 * "Sync now" leaves the menu for the pair; everything else rare stays in the
 * ⋯ menu beside the title, "Disconnect" among it.
 */
export function IntegrationSheetBody({
  slots,
  provider,
  providerName,
  description,
  loading = false,
  connected,
  health,
  primary,
  menu = [],
  details,
  diagnosticsExtra,
  setup,
  connectAction,
  testId,
  children,
}: IntegrationCardProps & { slots: IntegrationSheetSlots }) {
  const { t } = useTranslations();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = `${provider}-integration-details`;

  const body = (content: ReactNode) => (
    <div
      className="flex flex-col gap-4"
      data-testid={testId ?? `${provider}-card`}
      data-slot="integration-card"
      data-surface="sheet"
      data-integration={provider}
      data-state={
        loading
          ? "loading"
          : !connected
            ? "not_connected"
            : (health?.state ?? "unknown")
      }
    >
      {content}
    </div>
  );

  if (loading) {
    return body(
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>,
    );
  }

  if (!connected) {
    return body(
      <>
        {description ? (
          <div className="text-sm" data-slot="settings-card-description">
            {description}
          </div>
        ) : null}
        {setup ? <div data-slot="integration-setup">{setup}</div> : null}
        {children}
        {connectAction && slots.actions
          ? createPortal(connectAction, slots.actions)
          : null}
      </>,
    );
  }

  const syncItem = menu.find((item) => item.id === "sync");
  const rest = menu.filter((item) => item.id !== "sync");
  const action = health?.action ?? null;
  const primaryButton =
    action === "resume" && primary?.onResume ? (
      <PrimaryButton
        action="resume"
        icon={Play}
        label={t("settings.integrationCard.resume")}
        onClick={primary.onResume}
        pending={primary.pending}
        disabled={primary.disabled}
        provider={provider}
      />
    ) : primary?.onReconnect ? (
      <PrimaryButton
        action="reconnect"
        icon={Link2}
        label={t("settings.integrationCard.reconnect")}
        onClick={primary.onReconnect}
        pending={primary.pending}
        disabled={primary.disabled}
        provider={provider}
      />
    ) : null;

  const actions =
    syncItem || primaryButton ? (
      <>
        {syncItem?.onSelect ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={syncItem.onSelect}
            disabled={syncItem.disabled}
            data-slot="integration-sync-action"
            data-testid={`${provider}-sync-button`}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t("settings.integrationList.syncNow")}
          </Button>
        ) : null}
        {primaryButton}
      </>
    ) : null;

  return body(
    <>
      {children}
      {health ? (
        <>
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
            data-slot="integration-details-toggle"
            data-testid={`${provider}-details-toggle`}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -ml-1 flex min-h-11 items-center gap-2 self-start rounded-md px-1 text-sm outline-none focus-visible:ring-[3px] sm:min-h-9"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
                detailsOpen && "rotate-180",
              )}
            />
            {t("settings.integrationCard.details.title")}
          </button>
          <DetailsPanel
            id={detailsId}
            open={detailsOpen}
            text={diagnosticsText(
              {
                version: APP_VERSION,
                provider: providerName,
                health,
                extra: diagnosticsExtra,
              },
              t,
            )}
            unavailable={health.unavailable.map((u) =>
              unavailableItemLabel(u.item, t),
            )}
          >
            {details}
          </DetailsPanel>
        </>
      ) : details ? (
        <div className="space-y-3">{details}</div>
      ) : null}
      {actions && slots.actions ? createPortal(actions, slots.actions) : null}
      {rest.length > 0 && slots.menu
        ? createPortal(
            <IntegrationMenu
              provider={provider}
              providerName={providerName}
              items={rest}
              quiet
            />,
            slots.menu,
          )
        : null}
    </>,
  );
}
