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
   * Optional action rendered `shrink-0` at the trailing edge of the visible
   * header row (§11 inline-action-row: title `min-w-0 flex-1`, action
   * `shrink-0`). Use for a single quiet header control — e.g. the neutral
   * Coach icon on the document detail sheet. Ignored when `hideHeader` is set
   * (there is no visible header to hang it on). Sits left of the primitive's
   * absolute close button, whose space the header already reserves.
   */
  headerAction?: React.ReactNode;
  /**
   * Hide the visual header (title + description). The title remains
   * mounted in an `sr-only` block so the accessible name is still
   * announced. Use when the consumer renders its own header inside
   * the body.
   */
  hideHeader?: boolean;
  /**
   * Footer slot. Pass the action `<Button>`s directly (a fragment is
   * fine) — never a wrapper `<div className="flex …">`. The two
   * branches deliberately stack differently and both rely on owning
   * the flex context: the Sheet branch pins a `flex-row justify-end`
   * bar so Cancel/Save sit side by side above the keyboard, while the
   * Dialog branch defers to `DialogFooter`'s `flex-col-reverse
   * sm:flex-row` so narrow dialogs stack the primary action on top.
   * A consumer-supplied wrapper div collapses both into a single flex
   * child and breaks that responsive stacking. This split is a
   * decision, not drift — don't unify the two branches.
   *
   * Both branches keep the footer reachable once the body scrolls:
   * the Sheet branch sticky-pins it to the bottom of the bottom-sheet,
   * and the Dialog branch holds it `shrink-0` below the scrolling body.
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
  /**
   * Desktop (Dialog branch) content width. The bottom-sheet branch
   * always spans the viewport, so this prop only affects the `md+`
   * Dialog. Defaults to `"md"` (448 px) to preserve every existing
   * consumer; pass `"4xl"` for the wide medication editor's
   * two-column layout. The class is the only width utility applied —
   * the prior `cn("sm:max-w-md", className)` ordering let a
   * consumer-passed width silently collide with the hardcoded
   * default, so the width now resolves from this single source.
   */
  contentWidth?: "md" | "lg" | "2xl" | "3xl" | "4xl" | "6xl";
  /**
   * Where focus goes when the surface closes. Radix returns it to a
   * `Dialog.Trigger`, and this primitive has none, so a caller whose opener
   * should get focus back (a gear, a menu button) hands it over here: call
   * `event.preventDefault()` and focus the opener.
   */
  onCloseAutoFocus?: (event: Event) => void;
  children: React.ReactNode;
}

const CONTENT_WIDTH_CLASS: Record<
  NonNullable<ResponsiveSheetProps["contentWidth"]>,
  string
> = {
  md: "sm:max-w-md",
  lg: "sm:max-w-lg",
  "2xl": "sm:max-w-2xl",
  "3xl": "sm:max-w-3xl",
  "4xl": "sm:max-w-4xl",
  "6xl": "sm:max-w-6xl",
};

/**
 * v1.4.27 R3d MB1 — shared mount primitive that flips between a
 * bottom-anchored `<Sheet>` on narrow viewports and the existing
 * centred `<Dialog>` on tablet/desktop. Picks the breakpoint via
 * the `useIsMobile()` hook (Tailwind `md` — 768 px).
 *
 * Both branches use the same layout contract: cap the surface
 * height, scroll ONLY the body on overflow, and keep the footer
 * reachable. The Sheet branch caps at `90dvh` and sticky-pins the
 * footer so Save / Cancel stay reachable when the keyboard pushes
 * the bottom of the sheet up. The Dialog branch caps at the
 * primitive's `max-h-[calc(100dvh-2rem)]`, runs as a flex column,
 * and pins its header + footer (`shrink-0`) so the body — not the
 * whole grid — is what scrolls; the primary action never slides
 * below the fold under long forms, browser zoom, or OS scaling.
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
  headerAction,
  hideHeader = false,
  footer,
  className,
  bodyClassName,
  showCloseButton = true,
  contentWidth = "md",
  onCloseAutoFocus,
  children,
}: ResponsiveSheetProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          onCloseAutoFocus={onCloseAutoFocus}
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
              className={cn(
                "border-border/70 gap-1.5 border-b p-4",
                // Reserve the right gutter ONLY when the primitive paints its
                // absolute close button. With `showCloseButton={false}` the
                // consumer's own trailing control (headerAction) sits flush to
                // the `p-4` right edge instead of being pushed in by an empty
                // reserved gutter.
                showCloseButton && "pr-12",
                // Optical alignment for a consumer-rendered trailing control.
                // An icon button carries its own inner inset (a 20px glyph
                // centred in a 44px tap target sits 12px in), so at the plain
                // `p-4` right edge the GLYPH lands ~28px from the frame while
                // the title starts at 16px — visibly not flush. Trim the right
                // padding by that inset so the glyph aligns with the title's
                // edge; the tap target still reaches the frame.
                headerAction &&
                  !showCloseButton &&
                  "flex-row items-start justify-between gap-3 pr-1 sm:pr-2",
                headerAction &&
                  showCloseButton &&
                  "flex-row items-start justify-between gap-3",
              )}
            >
              {headerAction ? (
                <>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <SheetTitle className="text-base font-semibold">
                      {title}
                    </SheetTitle>
                    {description ? (
                      <SheetDescription className="text-muted-foreground text-xs">
                        {description}
                      </SheetDescription>
                    ) : null}
                  </div>
                  <div className="shrink-0">{headerAction}</div>
                </>
              ) : (
                <>
                  <SheetTitle className="text-base font-semibold">
                    {title}
                  </SheetTitle>
                  {description ? (
                    <SheetDescription className="text-muted-foreground text-xs">
                      {description}
                    </SheetDescription>
                  ) : null}
                </>
              )}
            </SheetHeader>
          )}
          <div
            data-slot="responsive-sheet-body"
            className={cn(
              // Vertical-only scroll port — see the note on the Dialog
              // branch's body below for why `overflow-y-auto` alone does not
              // say that.
              "flex min-h-0 flex-1 flex-col gap-4 overflow-x-clip overflow-y-auto p-4",
              bodyClassName,
            )}
          >
            {children}
          </div>
          {footer ? (
            <SheetFooter
              data-slot="responsive-sheet-footer"
              className="border-border/70 bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-0 mt-0 flex-row justify-end gap-2 border-t p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] backdrop-blur"
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
        onCloseAutoFocus={onCloseAutoFocus}
        showCloseButton={showCloseButton}
        data-slot="responsive-sheet-content"
        data-variant="dialog"
        // v1.21.1 — flip the desktop Dialog from the primitive's single
        // `overflow-y-auto` grid (where header + body + footer all scroll
        // together, so the primary CTA can slide below the fold once the
        // form, a long locale string, browser zoom, or OS display scaling
        // pushes the content past `max-h-[calc(100dvh-2rem)]`) to a flex
        // column that scrolls ONLY the body. This brings the Dialog branch
        // to parity with the Sheet branch, which already pins its footer.
        // The header + footer stay shrink-0 so the body absorbs every
        // height shortfall and the action row is always reachable without
        // scrolling. `overflow-hidden` makes the body the lone scroll port.
        className={cn(
          "flex flex-col overflow-hidden",
          CONTENT_WIDTH_CLASS[contentWidth],
          className,
        )}
      >
        {hideHeader ? (
          <DialogHeader className="sr-only">
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>
        ) : (
          <DialogHeader
            data-slot="responsive-sheet-header"
            className={cn(
              "shrink-0",
              headerAction && "flex-row items-start justify-between gap-3",
              // Reserve the trailing gutter for the primitive's absolute close
              // button ONLY when it is actually painted. With
              // `showCloseButton={false}` the headerAction sits flush to the
              // header's right edge instead of being pushed in.
              headerAction && showCloseButton && "pr-9",
            )}
          >
            {headerAction ? (
              <>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <DialogTitle>{title}</DialogTitle>
                  {description ? (
                    <DialogDescription>{description}</DialogDescription>
                  ) : null}
                </div>
                <div className="shrink-0">{headerAction}</div>
              </>
            ) : (
              <>
                <DialogTitle>{title}</DialogTitle>
                {description ? (
                  <DialogDescription>{description}</DialogDescription>
                ) : null}
              </>
            )}
          </DialogHeader>
        )}
        <div
          data-slot="responsive-sheet-body"
          className={cn(
            // `overflow-x-clip` states the invariant the surrounding comment
            // already claims: this body scrolls VERTICALLY. `overflow-y-auto`
            // alone does not say that — CSS promotes the other axis from
            // `visible` to `auto`, so any child wider than the port turned the
            // whole form into a sideways-pannable surface. That is how the
            // date/time row and `<SheetSection>`'s deliberate 4 px hover bleed
            // (`-mx-1 w-[calc(100%+0.5rem)]`) both produced a horizontal
            // scrollbar on the desktop dialog. `clip` is not `visible`, so the
            // promotion does not happen and the vertical scroll is kept.
            //
            // Content that genuinely needs to scroll sideways (a wide table)
            // owns its own `overflow-x-auto` wrapper — that is the correct
            // place for it, and it still works inside a clipped port.
            //
            // `-mr-3 pr-3` reclaims a 12 px scroll gutter from the dialog's own
            // `p-6` padding: the vertical scrollbar would otherwise render flush
            // against the body's right edge, exactly where a right-aligned child
            // (a slider's high anchor label) sits, painting on top of the last
            // characters. The margin gives the padding straight back, so content
            // alignment is unchanged — the scrollbar just lives beside the text
            // now, not on it. The mobile Sheet branch has its own `p-4` and
            // needs nothing.
            "-mr-3 flex min-h-0 flex-1 flex-col gap-4 overflow-x-clip overflow-y-auto pr-3",
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer ? (
          <DialogFooter
            data-slot="responsive-sheet-footer"
            className="shrink-0"
          >
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
