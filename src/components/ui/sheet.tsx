"use client";

import * as React from "react";
import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { ActionPair } from "@/components/ui/action-pair";
import { useTranslations } from "@/lib/i18n/context";
import {
  BottomSheetContent,
  type BottomSheetOptions,
} from "@/components/ui/bottom-sheet";

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A sheet from one edge. `side="bottom"` is the bottom sheet
 * (`bottom-sheet.tsx`): a grip, the drag, and the options in
 * `BottomSheetOptions`, which the other sides ignore.
 */
function SheetContent({
  side = "right",
  preview,
  previewLabels,
  draggable,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> &
  BottomSheetOptions & {
    side?: "top" | "right" | "bottom" | "left";
    showCloseButton?: boolean;
  }) {
  if (side === "bottom") {
    return (
      <BottomSheetContent
        preview={preview}
        previewLabels={previewLabels}
        draggable={draggable}
        {...props}
      />
    );
  }
  return <EdgeSheetContent side={side} {...props} />;
}

function EdgeSheetContent({
  className,
  children,
  side,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side: "top" | "right" | "left";
  showCloseButton?: boolean;
}) {
  const { t } = useTranslations();
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        // Read by the safe-area rules in `globals.css`: the full-height
        // sides keep clear of the status bar and the notch. Its own
        // attribute rather than `data-slot`, which consumers replace with
        // theirs.
        data-sheet-side={side}
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
          side === "right" &&
            "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
          side === "left" &&
            "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
          side === "top" &&
            "data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          // v1.4.27 — widen the icon-only close-X tap target to
          // a 36 px floor, matching the Dialog close-X treatment from
          // MB2 (Decision I). 36 px (not 44 px) is the intentional
          // exception for fixed icon-only close affordances per the
          // dialog primitive's rationale. The bottom sheet's X is 44 px
          // on its title row (`bottom-sheet.tsx`).
          <SheetPrimitive.Close
            data-slot="sheet-close-button"
            className="ring-offset-background focus-visible:border-ring focus-visible:ring-ring/50 text-muted-foreground hover:bg-accent hover:text-foreground absolute top-3 right-4 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none sm:min-h-9 sm:min-w-9 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            {/* v1.4.34 — read `common.close` so screen readers
                hear the localised label instead of literal English. */}
            <span className="sr-only">{t("common.close")}</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      // Reserve the trailing gutter for the absolute close-X the way
      // `DialogHeader` (pr-9) does, sized to the sheet's own close button
      // (`top-3 right-4`, min-w-9…11) so a long raw-`<Sheet>` title never
      // slides under the X — the Documents close-X overlap class, foreclosed
      // at the primitive. Consumers that render `showCloseButton={false}`
      // (or their own close affordance) drop it back with `pr-4` via
      // `className` — tailwind-merge keeps the later value.
      className={cn("flex flex-col gap-1.5 p-4 pr-12", className)}
      {...props}
    />
  );
}

/** The sheet's actions, laid out by `ActionPair` (see `DialogFooter`). */
function SheetFooter({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex p-4", className)}
      {...props}
    >
      <ActionPair>{children}</ActionPair>
    </div>
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-foreground font-semibold", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
