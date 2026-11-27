"use client";

/**
 * `<IntegrationCard>` — the one card every connection in Settings renders.
 *
 * A card says three things: whether it works (a badge with one word), what
 * that means (one sentence), and what the person can do (at most one button).
 * Everything else is either diagnostics, collapsed under "Details for a bug
 * report", or rarely needed, in the three-dot menu.
 *
 * The card renders the server's `health` and nothing else. It does not read a
 * ledger state, a verdict, a token expiry or a failure counter, and it never
 * decides a state of its own: the badge, the sentence and the button are each
 * a projection of one `ConnectionHealth`. Per-provider controllers (OAuth,
 * Nightscout, Apple Health) own the requests and hand the card their menu
 * entries, their primary handlers and anything that belongs in the details.
 *
 * Anatomy, top to bottom (design standards §1, §12, §13):
 *   header      `SettingsCardHeader`, the badge in its status slot
 *   sentence    `text-sm` foreground, then one muted meta line
 *   setup       not connected: the forms and guides, folded behind "Set up"
 *   body        transient lines a controller adds (a sync result, a form)
 *   details     collapsed, always present on a connected card
 *   actions     `SettingsCardActions`, the last element: menu left, at most
 *               one primary right
 */

import { useState, type ReactNode } from "react";
import { ChevronDown, Link2, Play, type LucideIcon } from "lucide-react";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { useIntegrationSheetSlots } from "@/components/settings/sheet-surface";
import { Disclosure } from "@/components/ui/disclosure";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type {
  ConnectionHealth,
  ConnectionHealthState,
} from "@/lib/integrations/connection-health";
import { cn } from "@/lib/utils";

import {
  APP_VERSION,
  DetailsPanel,
  IntegrationMenu,
  PrimaryButton,
  type IntegrationMenuAction,
  type IntegrationPrimaryHandlers,
} from "./integration-card-parts";
import { IntegrationSheetBody } from "./integration-sheet-body";
import {
  diagnosticsText,
  formatHealthInstant,
  healthSentence,
  healthStatusTone,
  unavailableItemLabel,
} from "./integration-health-copy";

/**
 * The status chip for a connection. `ok` and `limited` read "Active",
 * `degraded` and `action_required` read "Error"; the sentence under the
 * header says which and why (`healthSentence`).
 */
export function HealthBadge({ state }: { state: ConnectionHealthState }) {
  return (
    <StatusChip
      data-slot="integration-health-badge"
      data-state={state}
      tone={healthStatusTone(state)}
    />
  );
}

export type {
  IntegrationMenuAction,
  IntegrationPrimaryHandlers,
} from "./integration-card-parts";

export interface IntegrationCardProps {
  /** Connection key; drives `data-integration` and the testids. */
  provider: string;
  /** Provider name used inside sentences and the diagnostics. */
  providerName: string;
  icon: LucideIcon;
  title?: ReactNode;
  titleAccessory?: ReactNode;
  /** One meta sentence with the setup-guide link; shown while not connected. */
  description?: ReactNode;
  /** The status has not loaded yet. */
  loading?: boolean;
  connected: boolean;
  /** The server-resolved health; null when the server has none to give. */
  health: ConnectionHealth | null;
  /** Server fact: older history is still loading in the background. */
  historyLoading?: boolean;
  /** Apple Health's "open HealthLog on your iPhone" sentence variant. */
  appleHealth?: boolean;
  primary?: IntegrationPrimaryHandlers;
  menu?: IntegrationMenuAction[];
  /** Provider extras for the details section (lists, delivery facts). */
  details?: ReactNode;
  /** Extra redacted lines for the copied diagnostics. */
  diagnosticsExtra?: readonly string[];
  /** Lines below the sentence: results, errors, an opened form. */
  children?: ReactNode;
  /** Not connected: the forms and guides that come before connecting. */
  setup?: ReactNode;
  /** Not connected: the one primary button, usually "Connect". */
  connectAction?: ReactNode;
  /** Overrides the `<provider>-card` testid (the read-only fallback row). */
  testId?: string;
}

export function IntegrationCard(props: IntegrationCardProps) {
  const {
    provider,
    providerName,
    icon,
    title,
    titleAccessory,
    description,
    loading = false,
    connected,
    health,
    historyLoading,
    appleHealth,
    primary,
    menu = [],
    details,
    diagnosticsExtra,
    children,
    setup,
    connectAction,
    testId,
  } = props;
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = `${provider}-integration-details`;
  // Inside an integration sheet the sheet is the frame (`sheet-surface.ts`).
  const sheetSlots = useIntegrationSheetSlots();
  if (sheetSlots) return <IntegrationSheetBody slots={sheetSlots} {...props} />;

  const cardState = loading
    ? "loading"
    : !connected
      ? "not_connected"
      : (health?.state ?? "unknown");

  const header = (
    <SettingsCardHeader
      icon={icon}
      title={title ?? providerName}
      titleAccessory={titleAccessory}
      description={!loading && !connected ? description : undefined}
      status={
        loading ? null : !connected ? (
          <StatusChip tone="off" data-state="not_connected" />
        ) : health ? (
          <HealthBadge state={health.state} />
        ) : null
      }
    />
  );

  const shell = (body: ReactNode) => (
    <SettingsCard
      data-testid={testId ?? `${provider}-card`}
      data-slot="integration-card"
      data-integration={provider}
      data-state={cardState}
    >
      {header}
      {body}
    </SettingsCard>
  );

  if (loading) {
    // A loading state paints the card and its header (§13), so the page does
    // not move when the status lands.
    return shell(
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>,
    );
  }

  if (!connected) {
    return shell(
      <>
        <IntegrationSetupFold>{setup}</IntegrationSetupFold>
        {children}
        {connectAction ? (
          <SettingsCardActions data-slot="integration-actions">
            {connectAction}
          </SettingsCardActions>
        ) : null}
      </>,
    );
  }

  const sentence = health
    ? healthSentence(health, t, {
        provider: providerName,
        historyLoading,
        appleHealth,
        locale,
        fmt,
      })
    : null;
  const lastData = health
    ? health.lastDataAt
      ? t("settings.integrationCard.lastData", {
          when: formatHealthInstant(health.lastDataAt, t, fmt),
        })
      : t("settings.integrationCard.lastDataNone")
    : null;

  const action = health?.action ?? null;
  const primaryButton =
    action === "reconnect" && primary?.onReconnect ? (
      <PrimaryButton
        action="reconnect"
        icon={Link2}
        label={t("settings.integrationCard.reconnect")}
        onClick={primary.onReconnect}
        pending={primary.pending}
        disabled={primary.disabled}
        provider={provider}
      />
    ) : action === "resume" && primary?.onResume ? (
      <PrimaryButton
        action="resume"
        icon={Play}
        label={t("settings.integrationCard.resume")}
        onClick={primary.onResume}
        pending={primary.pending}
        disabled={primary.disabled}
        provider={provider}
      />
    ) : null;

  return shell(
    <>
      {sentence || lastData ? (
        <div className="space-y-1">
          {sentence ? (
            <p className="text-sm" data-slot="integration-sentence">
              {sentence}
            </p>
          ) : null}
          {lastData ? (
            <p
              className="text-muted-foreground text-xs"
              data-slot="integration-last-data"
            >
              {lastData}
            </p>
          ) : null}
        </div>
      ) : null}
      {children}
      {health ? (
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
      ) : details ? (
        <div className="space-y-3">{details}</div>
      ) : null}
      {health || menu.length > 0 || primaryButton ? (
        <SettingsCardActions
          data-slot="integration-actions"
          leading={
            health ? (
              <button
                type="button"
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                onClick={() => setDetailsOpen((open) => !open)}
                data-slot="integration-details-toggle"
                data-testid={`${provider}-details-toggle`}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -ml-1 flex min-h-11 items-center gap-2 rounded-md px-1 text-sm outline-none focus-visible:ring-[3px] sm:min-h-9"
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
            ) : null
          }
        >
          {menu.length > 0 ? (
            <IntegrationMenu
              provider={provider}
              providerName={providerName}
              items={menu}
            />
          ) : null}
          {primaryButton}
        </SettingsCardActions>
      ) : null}
    </>,
  );
}

/**
 * The forms, guides and help a connection needs before it connects, folded
 * under "Set up": a page of eleven cards read as eleven sets of instructions
 * while they stood open. Renders nothing when the card brings none.
 */
function IntegrationSetupFold({ children }: { children?: ReactNode }) {
  const { t } = useTranslations();
  if (!children) return null;
  return (
    <Disclosure
      framed
      data-fold
      data-slot="integration-setup"
      summary={t("settings.integrationCard.setUp")}
    >
      {children}
    </Disclosure>
  );
}
