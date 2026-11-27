"use client";

/**
 * The pieces an integration card and an integration sheet share: the one
 * primary button, the ⋯ menu with its confirmations, and the bug-report
 * details. Split out of `integration-card.tsx` so the sheet body can use them
 * without the card and the body importing each other.
 */

import { useState, type ReactNode } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/** The app version the build stamped; empty in a dev build. */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";

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

export function PrimaryButton({
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
export function IntegrationMenu({
  provider,
  providerName,
  items,
  quiet = false,
}: {
  provider: string;
  providerName: string;
  items: IntegrationMenuAction[];
  /** A ghost trigger, for the sheet's title row. */
  quiet?: boolean;
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
            variant={quiet ? "ghost" : "outline"}
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
          align={quiet ? "end" : "start"}
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
export function DetailsPanel({
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
