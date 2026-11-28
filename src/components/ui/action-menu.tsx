"use client";

import * as React from "react";
import { MoreHorizontal } from "lucide-react";

import { MenuInHeaderContext } from "@/components/ui/action-pair";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * The "⋯" of an action row: whatever does not fit the pair (reset, delete,
 * a rarely used alternative). Pass `DropdownMenuItem`s as children.
 */
export function ActionMenu({
  children,
  disabled,
  label,
  slot = "action-menu",
  quiet = false,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  /** Accessible name; "More options" by default. */
  label?: string;
  /** `data-slot` of the trigger, for tests; `action-menu` by default. */
  slot?: string;
  /** A borderless trigger, for a "⋯" standing on its own (a list's). */
  quiet?: boolean;
}) {
  const { t } = useTranslations();
  // In a sheet's header it is a quiet icon beside the close button, the same
  // size and weight; in a dialog's row a framed button beside the pair.
  const inHeader = React.useContext(MenuInHeaderContext) || quiet;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={inHeader ? "ghost" : "outline"}
          size="icon"
          className={cn(
            "max-sm:size-11",
            inHeader && "text-muted-foreground hover:text-foreground sm:size-9",
          )}
          data-slot={slot}
          disabled={disabled}
          aria-label={label ?? t("common.moreOptions")}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How `ActionPair` recognises the menu without importing this file. */
ActionMenu.actionMenu = true;
