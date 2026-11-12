"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { SeededFormDiscardDialog } from "@/components/forms/use-seeded-form-dismissal";
import {
  sheetHistory,
  type SheetHistoryEntry,
} from "@/components/ui/sheet-history";
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
  /**
   * Whether the form holds input a dismissal would lose. A backdrop tap,
   * Escape, a swipe down, the X and Back then ask before closing; the form's
   * own Cancel and Save close it as before. A function is read at the moment
   * of the dismissal and gets this sheet's body: pass
   * `sheetBodyHasUnsavedInput` for an add form that keeps its state inside.
   */
  dirty?: boolean | ((body: HTMLElement | null) => boolean);
  /**
   * Back closes the sheet (`sheet-history.ts`). False for a sheet whose open
   * state lives in the URL already, which has its own history entry.
   */
  historyEntry?: boolean;
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
 * v1.4.27 — shared mount primitive that flips between a
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
/**
 * Phone branch only: on open, focus the sheet itself instead of its first
 * field. Radix's default lands on the first tabbable element, and when that
 * is a text-like field (a date, a name) the phone raises its keyboard over a
 * sheet the person has not read yet, and the sheet jumps up under it. Focus
 * still moves into the sheet (the content is focusable and traps focus), a
 * field a form focuses on purpose (`autoFocus`, a mount effect) keeps it, and
 * the desktop dialog keeps the default.
 */
export function keepKeyboardDownOnOpen(event: Event): void {
  event.preventDefault();
  const content = event.currentTarget as HTMLElement | null;
  if (content && !content.contains(document.activeElement)) {
    content.focus({ preventScroll: true });
  }
}

/**
 * The fallback dirty check for an add form that keeps its state inside the
 * sheet body: any text field with a value, a checkbox or radio moved off its
 * default, a slider moved off unanswered, a chosen `role="radio"` (the mood
 * faces) or a Select that is open. The date and time fields are skipped,
 * because the forms fill them with "now", and so is the input a slider keeps
 * for its form. A field the form fills itself names that value in
 * `data-seed` (a controlled input's `defaultValue` follows its value, so it
 * cannot say). An edit form starts filled and has to say for itself whether
 * anything changed.
 */
export function sheetBodyHasUnsavedInput(body: HTMLElement | null): boolean {
  if (!body) return false;
  const fields = body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  );
  for (const field of fields) {
    if (field.disabled || field.type === "hidden") continue;
    if (
      field.closest(
        '[data-slot="date-field"], [data-slot="time-field"], [data-slot="slider"]',
      )
    ) {
      continue;
    }
    if (field.type === "checkbox" || field.type === "radio") {
      const box = field as HTMLInputElement;
      if (box.checked !== box.defaultChecked) return true;
      continue;
    }
    if (field.value.trim() !== (field.dataset.seed ?? "").trim()) return true;
  }
  if (
    body.querySelector('[data-slot="slider-field"]:not([data-unset])') !== null
  ) {
    return true;
  }
  // Mood faces start with none chosen, so any chosen one is input.
  if (body.querySelector('[role="radio"][aria-checked="true"]') !== null) {
    return true;
  }
  // A Select that is open is a choice being made. One merely off its
  // placeholder is not: the type and medication selects open on a default.
  if (body.querySelector('[role="combobox"][data-state="open"]') !== null) {
    return true;
  }
  return false;
}

/**
 * How a sheet closes: a dismissal with unsaved input asks first, and Back
 * closes the sheet (asking the same way) instead of leaving the page.
 */
function useSheetDismissal({
  open,
  onOpenChange,
  dirty,
  historyEntry,
}: Pick<
  ResponsiveSheetProps,
  "open" | "onOpenChange" | "dirty" | "historyEntry"
>) {
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const entryRef = React.useRef<SheetHistoryEntry | null>(null);
  const [asking, setAsking] = React.useState(false);
  const [backs, countBack] = React.useReducer((n: number) => n + 1, 0);
  if (!open && asking) setAsking(false);

  const hasUnsavedInput = () =>
    typeof dirty === "function" ? dirty(bodyRef.current) : dirty === true;

  // Every dismissal Radix reports (backdrop, Escape, swipe, the X).
  const handleOpenChange = (next: boolean) => {
    if (!next && hasUnsavedInput()) {
      setAsking(true);
      return;
    }
    onOpenChange(next);
  };

  const handleBack = React.useEffectEvent(() => {
    // Back while the question is open answers it with "keep editing".
    if (asking || hasUnsavedInput()) {
      entryRef.current?.restore();
      setAsking(!asking);
      return;
    }
    countBack();
    onOpenChange(false);
  });

  React.useEffect(() => {
    if (!open || historyEntry === false) return;
    const entry = sheetHistory()?.open(() => handleBack());
    if (!entry) return;
    entryRef.current = entry;
    return () => {
      entry.release();
      if (entryRef.current === entry) entryRef.current = null;
    };
  }, [open, historyEntry]);

  // Back was answered and the sheet is still open: its owner kept it (its
  // own discard question, a save under way), so Back must keep working.
  React.useEffect(() => {
    if (backs > 0 && open) entryRef.current?.restore();
  }, [backs, open]);

  // A sibling of the sheet, not a child: inside it, a touch on the question
  // would reach the sheet's drag through the React tree.
  const discard =
    dirty === undefined ? null : (
      <SeededFormDiscardDialog
        open={asking}
        onConfirm={() => {
          setAsking(false);
          onOpenChange(false);
        }}
        onCancel={() => setAsking(false)}
      />
    );

  return { bodyRef, handleOpenChange, discard };
}

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
  dirty,
  historyEntry,
  children,
}: ResponsiveSheetProps) {
  const isMobile = useIsMobile();
  const { bodyRef, handleOpenChange, discard } = useSheetDismissal({
    open,
    onOpenChange,
    dirty,
    historyEntry,
  });

  if (isMobile) {
    return (
      <>
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetContent
            onCloseAutoFocus={onCloseAutoFocus}
            onOpenAutoFocus={keepKeyboardDownOnOpen}
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
                  // Under the sheet's grip; the header drags the sheet, so a
                  // touch on it never pans or pulls the page.
                  "border-border/70 touch-none gap-1.5 border-b p-4",
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
              ref={bodyRef}
              data-slot="responsive-sheet-body"
              className={cn(
                // Vertical-only scroll port — see the note on the Dialog
                // branch's body below for why `overflow-y-auto` alone does not
                // say that. `overscroll-contain`: a flick that reaches the end
                // of the form stops there instead of chaining into the page
                // (or the browser's pull-to-refresh) behind the sheet.
                "flex min-h-0 flex-1 flex-col gap-4 overflow-x-clip overflow-y-auto overscroll-contain p-4",
                // Without a footer the body is the sheet's bottom edge, so it
                // keeps its last row above the home indicator of an
                // installed app; the footer does that when there is one.
                // Standing on the keyboard, the sheet is clear of the
                // indicator already; the inset would leave a gap above it.
                !footer &&
                  "keyboard-open:pb-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]",
                bodyClassName,
              )}
            >
              {children}
            </div>
            {footer ? (
              <SheetFooter
                data-slot="responsive-sheet-footer"
                className="border-border/70 bg-background/95 supports-[backdrop-filter]:bg-background/80 keyboard-open:pb-4 sticky bottom-0 mt-0 flex-row justify-end gap-2 border-t p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] backdrop-blur"
              >
                {footer}
              </SheetFooter>
            ) : null}
          </SheetContent>
        </Sheet>
        {discard}
      </>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
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
            ref={bodyRef}
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
      {discard}
    </>
  );
}
