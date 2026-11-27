"use client";

import * as React from "react";
import { createPortal } from "react-dom";
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
 * right edge; on a phone the pair takes the whole row in two halves. Anything
 * beyond the two goes into an `ActionMenu` (the "⋯"). Inside a
 * `ResponsiveSheet` the menu stands in the sheet's header beside the close
 * button (`ActionMenuSlot`), so a sheet's footer holds exactly the pair; in a
 * plain dialog it stands at the left edge of the row.
 *
 * `DialogFooter`, `SheetFooter` (and so every `ResponsiveSheet` footer) and
 * `AlertDialogFooter` lay their children out through this, so a call site
 * passes its buttons and nothing else. A footer that portals its buttons in
 * from the form (a lone host `<div>` as the only child) gets the whole row,
 * and the form renders its own `ActionPair` into it.
 *
 * Labels are written to fit half a phone row. Should one not (a long locale
 * on a narrow phone), the two buttons stack, each the full width, the
 * primary last: a last resort, measured rather than guessed from a
 * breakpoint. The row owns the buttons' height: 44 px on a phone, the
 * button's own size above it. Guard: `action-pair-guard.test.ts` (two
 * buttons per footer).
 */
function ActionPair({
  className,
  pairClassName,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  /**
   * Width rules of the pair itself, for a surface that lines several pairs
   * up in one column (the start page's asks give every button one width).
   */
  pairClassName?: string;
}) {
  const items = flatten(children);
  const menus = items.filter(isActionMenu);
  const actions = items.filter((item) => !isActionMenu(item));

  const menuSlot = React.useContext(MenuSlotContext);
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
      // Too wide for its room, or (filling the row on a phone) a label wider
      // than its half.
      const over =
        pair.offsetWidth > room + 0.5 ||
        pair.scrollWidth > pair.clientWidth + 1;
      pair.dataset.stacked = over ? "true" : "false";
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
      className={cn(
        "flex w-full min-w-0 items-center gap-2 has-[[data-stacked=true]]:items-end",
        className,
      )}
      {...props}
    >
      {menus.length > 0 && menuSlot
        ? createPortal(
            <MenuInHeaderContext.Provider value={true}>
              {menus}
            </MenuInHeaderContext.Provider>,
            menuSlot,
          )
        : null}
      {menus.length > 0 && !menuSlot ? (
        <div ref={menuRef} className="flex shrink-0 items-center gap-2">
          {menus}
        </div>
      ) : null}
      <div
        ref={pairRef}
        data-slot="action-pair"
        className={cn(
          "ml-auto grid w-max shrink-0 auto-cols-fr grid-flow-col gap-2 *:w-full data-[stacked=true]:w-auto data-[stacked=true]:min-w-0 data-[stacked=true]:flex-1 data-[stacked=true]:auto-cols-auto data-[stacked=true]:grid-flow-row max-sm:w-full max-sm:*:min-h-11",
          pairClassName,
        )}
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

const MenuSlotContext = React.createContext<HTMLElement | null>(null);
const MenuInHeaderContext = React.createContext(false);

/**
 * Where a surface wants its "⋯": `ResponsiveSheet` provides the element in
 * its header, and every `ActionPair` inside the sheet (its footer prop, or a
 * form portalling its own pair into the footer) renders its menu there.
 */
function ActionMenuSlot({
  slot,
  children,
}: {
  slot: HTMLElement | null;
  children: React.ReactNode;
}) {
  return (
    <MenuSlotContext.Provider value={slot}>{children}</MenuSlotContext.Provider>
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

export { ActionMenu, ActionMenuSlot, ActionPair };
