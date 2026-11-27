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
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  MoreHorizontal,
  Play,
  type LucideIcon,
} from "lucide-react";

import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { ConfirmDialog } from "@/components/ui/confirm-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type {
  ConnectionHealth,
  ConnectionHealthState,
} from "@/lib/integrations/connection-health";
import { cn } from "@/lib/utils";

import {
  diagnosticsText,
  formatHealthInstant,
  healthSentence,
  healthStatusTone,
  unavailableItemLabel,
} from "./integration-health-copy";

/** The app version the build stamped; empty in a dev build. */
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";

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

export interface IntegrationMenuAction {
  /** Stable id; becomes `data-action` and the `<provider>-menu-<id>` testid. */
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect?: () => void;
  /** Navigates instead of acting. External links open in a new tab. */
  href?: string;
  external?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  /** Ask first; the action runs from the dialog's confirm button. */
  confirm?: { title: string; body: string; confirmLabel: string };
}

export interface IntegrationPrimaryHandlers {
  onReconnect?: () => void;
  onResume?: () => void;
  pending?: boolean;
  disabled?: boolean;
}

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

export function IntegrationCard({
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
}: IntegrationCardProps) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = `${provider}-integration-details`;

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

function PrimaryButton({
  action,
  icon: Icon,
  label,
  onClick,
  pending,
  disabled,
  provider,
}: {
  action: "reconnect" | "resume";
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  pending?: boolean;
  disabled?: boolean;
  provider: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      className="min-h-11 sm:min-h-9"
      onClick={onClick}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      data-slot="integration-primary-action"
      data-action={action}
      data-testid={`${provider}-${action}-button`}
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
      ) : (
        <Icon className="size-3.5" aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}

/**
 * The rare actions. A destructive or heavy entry asks first through the same
 * confirmation the card used before; the dialog is controlled here because a
 * menu item closes its menu, and with it any dialog nested inside.
 */
function IntegrationMenu({
  provider,
  providerName,
  items,
}: {
  provider: string;
  providerName: string;
  items: IntegrationMenuAction[];
}) {
  const { t } = useTranslations();
  const [confirming, setConfirming] = useState<IntegrationMenuAction | null>(
    null,
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="min-h-11 min-w-11 sm:size-9 sm:min-h-9 sm:min-w-9"
            aria-label={t("settings.integrationCard.menuLabel", {
              provider: providerName,
            })}
            data-slot="integration-menu-trigger"
            data-testid={`${provider}-menu`}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64 max-w-[calc(100vw-2rem)]"
          data-slot="integration-menu"
        >
          {items.map((item) => {
            const Icon = item.icon;
            const common = {
              "data-slot": "integration-menu-item",
              "data-action": item.id,
              "data-testid": `${provider}-menu-${item.id}`,
              disabled: item.disabled,
              variant: item.destructive
                ? ("destructive" as const)
                : ("default" as const),
            };
            if (item.href) {
              return (
                <DropdownMenuItem key={item.id} asChild {...common}>
                  <a
                    href={item.href}
                    {...(item.external
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : {})}
                  >
                    <Icon aria-hidden="true" />
                    {item.label}
                    {item.external ? (
                      <ExternalLink
                        aria-hidden="true"
                        className="ml-auto size-3"
                      />
                    ) : null}
                  </a>
                </DropdownMenuItem>
              );
            }
            return (
              <DropdownMenuItem
                key={item.id}
                {...common}
                onSelect={() => {
                  if (item.confirm) setConfirming(item);
                  else item.onSelect?.();
                }}
              >
                <Icon aria-hidden="true" />
                {item.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirming?.confirm ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
          title={confirming.confirm.title}
          body={confirming.confirm.body}
          confirmLabel={confirming.confirm.confirmLabel}
          destructive={confirming.destructive}
          slot={`${provider}-${confirming.id}`}
          onConfirm={() => {
            const run = confirming.onSelect;
            setConfirming(null);
            run?.();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * "Details for a bug report": collapsed by default and present in every state,
 * so a report always looks the same. Its toggle sits at the start of the
 * action row and the panel opens above that row, which stays the last thing in
 * the card. The monospace block is exactly the text the copy button places on
 * the clipboard. The panel is always in the markup and `hidden` while closed,
 * so what a report would contain is inspectable without opening it.
 */
function DetailsPanel({
  id,
  open,
  text,
  unavailable,
  children,
}: {
  id: string;
  open: boolean;
  text: string;
  unavailable: string[];
  children?: ReactNode;
}) {
  const { t } = useTranslations();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
      window.setTimeout(() => setCopy("idle"), 2000);
    } catch {
      setCopy("failed");
    }
  }

  return (
    <div
      id={id}
      hidden={!open}
      className="space-y-3"
      data-slot="integration-details"
      data-state={open ? "open" : "closed"}
    >
      {unavailable.length > 0 ? (
        <p className="text-sm" data-slot="integration-unavailable-list">
          {t("settings.integrationCard.details.unavailableList", {
            list: unavailable.join(", "),
          })}
        </p>
      ) : null}
      {children}
      <pre
        className="bg-muted/40 text-foreground overflow-x-auto rounded-lg border p-3 font-mono text-xs leading-relaxed whitespace-pre"
        data-slot="integration-diagnostics"
      >
        {text}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={handleCopy}
          data-slot="integration-diagnostics-copy"
        >
          {copy === "copied" ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
          {t("common.copy")}
        </Button>
        <span
          role="status"
          aria-live="polite"
          data-slot="integration-diagnostics-copy-status"
          data-state={copy}
          className={cn(
            "text-xs",
            copy === "failed" ? "text-destructive" : "text-success",
          )}
        >
          {copy === "copied"
            ? t("common.copied")
            : copy === "failed"
              ? t("settings.integrationCard.details.copyFailed")
              : ""}
        </span>
      </div>
    </div>
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
