"use client";

import * as React from "react";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * The one shape of a dialog's or a sheet's actions: at most two buttons, the
 * secondary left of the primary, both as wide as the wider of the two, at the
 * right edge. Anything beyond the two goes into an `ActionMenu` (the "⋯"),
 * which stands at the left edge of the same row.
 *
 * `DialogFooter`, `SheetFooter` (and so every `ResponsiveSheet` footer) and
 * `AlertDialogFooter` lay their children out through this, so a call site
 * passes its buttons and nothing else. A footer that portals its buttons in
 * from the form (a lone host `<div>` as the only child) gets the whole row,
 * and the form renders its own `ActionPair` into it.
 *
 * When the pair does not fit beside the menu (a long label in a narrow sheet,
 * a long locale) the two buttons stack, each the full width, the primary
 * last. It is measured, not guessed from a breakpoint: "Speichern" and
 * "Abbrechen" sit side by side on a 320 px phone, "Enregistrer et suivant"
 * does not. Guard: `action-pair-guard.test.ts` (two buttons per footer).
 */
function ActionPair({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const items = flatten(children);
  const menus = items.filter(isActionMenu);
  const actions = items.filter((item) => !isActionMenu(item));

  const rowRef = React.useRef<HTMLDivElement>(null);
  const pairRef = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Toggled on the element itself, not through state: a measurement that
  // re-rendered the footer would measure again and could flip forever.
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    const pair = pairRef.current;
    if (!row || !pair) return;
    const fit = () => {
      pair.dataset.stacked = "false";
      const menu = menuRef.current;
      const gap = 8;
      const room = row.clientWidth - (menu ? menu.offsetWidth + gap : 0);
      pair.dataset.stacked = pair.offsetWidth > room + 0.5 ? "true" : "false";
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(row);
    return () => observer.disconnect();
  });

  if (
    items.length === 1 &&
    React.isValidElement(items[0]) &&
    items[0].type === "div"
  ) {
    return items[0];
  }

  return (
    <div
      ref={rowRef}
      data-slot="action-pair-row"
      className={cn("flex w-full min-w-0 items-center gap-2", className)}
      {...props}
    >
      {menus.length > 0 ? (
        <div ref={menuRef} className="flex shrink-0 items-center gap-2">
          {menus}
        </div>
      ) : null}
      <div
        ref={pairRef}
        data-slot="action-pair"
        className="ml-auto grid w-max shrink-0 auto-cols-fr grid-flow-col gap-2 data-[stacked=true]:w-auto data-[stacked=true]:min-w-0 data-[stacked=true]:flex-1 data-[stacked=true]:auto-cols-auto data-[stacked=true]:grid-flow-row [&>*]:w-full"
      >
        {actions}
      </div>
    </div>
  );
}

/**
 * The "⋯" of an action row: whatever does not fit the pair (reset, delete,
 * a rarely used alternative). Pass `DropdownMenuItem`s as children.
 */
function ActionMenu({
  children,
  disabled,
  label,
  slot = "action-menu",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  /** Accessible name; "More options" by default. */
  label?: string;
  /** `data-slot` of the trigger, for tests; `action-menu` by default. */
  slot?: string;
}) {
  const { t } = useTranslations();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
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

function isActionMenu(node: React.ReactNode): boolean {
  return React.isValidElement(node) && node.type === ActionMenu;
}

/** Children with fragments opened, holes (`false`, `null`) dropped. */
function flatten(children: React.ReactNode): React.ReactNode[] {
  return React.Children.toArray(children).flatMap((child) =>
    React.isValidElement<{ children?: React.ReactNode }>(child) &&
    child.type === React.Fragment
      ? flatten(child.props.children)
      : [child],
  );
}

export { ActionMenu, ActionPair };
