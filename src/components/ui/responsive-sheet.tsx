"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export interface ResponsiveSheetProps {
  /** Controlled open state. */
  open: boolean;
  /** Open-state setter forwarded to the underlying Sheet / Dialog root. */
  onOpenChange: (open: boolean) => void;
  /**
   * Required accessible title. Rendered inside the sheet / dialog
   * header so screen-readers always announce the surface, even when
   * the visual header is empty.
   */
  title: React.ReactNode;
  /** Optional short description rendered beneath the title. */
  description?: React.ReactNode;
  /**
   * Hide the visual header (title + description). The title remains
   * mounted in an `sr-only` block so the accessible name is still
   * announced. Use when the consumer renders its own header inside
   * the body.
   */
  hideHeader?: boolean;
  /**
   * Footer slot. The Sheet branch sticky-pins the footer to the
   * bottom of the bottom-sheet so the primary CTA stays reachable
   * once the body scrolls; the Dialog branch lets the footer flow
   * normally beneath the body.
   */
  footer?: React.ReactNode;
  /** Class name applied to the content surface (sheet / dialog). */
  className?: string;
  /** Class name applied to the body wrapper. */
  bodyClassName?: string;
  /**
   * Forward to the underlying Sheet/Dialog `showCloseButton`
   * primitive prop. Defaults to `true`; pass `false` when the
   * consumer renders its own close affordance inside the header.
   */
  showCloseButton?: boolean;
  children: React.ReactNode;
}

/**
 * v1.4.27 R3d MB1 — shared mount primitive that flips between a
 * bottom-anchored `<Sheet>` on narrow viewports and the existing
 * centred `<Dialog>` on tablet/desktop. Picks the breakpoint via
 * the `useIsMobile()` hook (Tailwind `md` — 768 px).
 *
 * On the Sheet branch we cap the content at `90dvh`, scroll the
 * body on overflow, and sticky-pin the footer so Save / Cancel
 * stay reachable when the keyboard pushes the bottom of the sheet
 * up. The Dialog branch consumes the primitive's `max-h-[calc(100dvh-2rem)]`
 * default so long forms scroll inside the dialog instead of
 * spilling off-screen on tablet portrait.
 *
 * Consumers swap `<Dialog>` → `<ResponsiveSheet>` and feed the
 * existing form markup through `children` / `footer`. The rest of
 * the form's chrome is unchanged because both branches expose the
 * same header / body / footer slot shape.
 */
export function ResponsiveSheet({
  open,
  onOpenChange,
  title,
  description,
  hideHeader = false,
  footer,
  className,
  bodyClassName,
  showCloseButton = true,
  children,
}: ResponsiveSheetProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={showCloseButton}
          data-slot="responsive-sheet-content"
          data-variant="sheet"
          className={cn(
            // Cap at 90 dvh so the user sees a slice of the page
            // behind the sheet (clear "this is a sheet, not a
            // takeover") + the bottom-sheet rounded top edge that
            // matches the iOS feel.
            "flex max-h-[90dvh] flex-col gap-0 rounded-t-2xl p-0",
            className,
          )}
        >
          {hideHeader ? (
            <SheetHeader className="sr-only">
              <SheetTitle>{title}</SheetTitle>
              {description ? (
                <SheetDescription>{description}</SheetDescription>
              ) : null}
            </SheetHeader>
          ) : (
            <SheetHeader
              data-slot="responsive-sheet-header"
              className="border-border/70 gap-1.5 border-b p-4 pr-12"
            >
              <SheetTitle className="text-base font-semibold">
                {title}
              </SheetTitle>
              {description ? (
                <SheetDescription className="text-muted-foreground text-xs">
                  {description}
                </SheetDescription>
              ) : null}
            </SheetHeader>
          )}
          <div
            data-slot="responsive-sheet-body"
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
              bodyClassName,
            )}
          >
            {children}
          </div>
          {footer ? (
            <SheetFooter
              data-slot="responsive-sheet-footer"
              className="border-border/70 sticky bottom-0 mt-0 flex-row justify-end gap-2 border-t bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/80"
            >
              {footer}
            </SheetFooter>
          ) : null}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={showCloseButton}
        data-slot="responsive-sheet-content"
        data-variant="dialog"
        className={cn("sm:max-w-md", className)}
      >
        {hideHeader ? (
          <DialogHeader className="sr-only">
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>
        ) : (
          <DialogHeader data-slot="responsive-sheet-header">
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>
        )}
        <div
          data-slot="responsive-sheet-body"
          className={cn("flex flex-col gap-4", bodyClassName)}
        >
          {children}
        </div>
        {footer ? (
          <DialogFooter data-slot="responsive-sheet-footer">
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
