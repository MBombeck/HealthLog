"use client";

import * as React from "react";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { ActionPair } from "@/components/ui/action-pair";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  const { t } = useTranslations();
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // v1.4.27 — cap `<DialogContent>` at the viewport's
          // dynamic height with internal scroll so long forms (medication
          // editor, API endpoint, intake import) never spill past the
          // viewport on short / soft-keyboard-collapsed mobile screens.
          // Consumers that need a different ceiling can override via
          // `className`.
          //
          // `grid-cols-[minmax(0,1fr)]` pins the implicit column. A bare
          // `grid` gives its single column an `auto` track, which sizes to the
          // widest child's max-content and grows the box past the dialog's own
          // `max-w-*` — and because `overflow-y:auto` makes `overflow-x`
          // compute to `auto`, that surplus becomes a horizontal scrollbar
          // rather than a visible spill. `minmax(0,1fr)` caps the track at the
          // dialog width so an over-wide child is contained instead of
          // dragging the surface out with it.
          //
          // `overflow-x-clip` pairs with it: `overflow-y-auto` alone promotes
          // the other axis from `visible` to `auto`, so a single over-wide
          // child made the whole dialog pannable sideways. A dialog scrolls
          // vertically; anything that genuinely needs sideways scroll brings
          // its own `overflow-x-auto` wrapper. Consumers that set `overflow-*`
          // themselves still win — `<ResponsiveSheet>` passes
          // `overflow-hidden` and scrolls its body instead.
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] grid-cols-[minmax(0,1fr)] gap-4 overflow-x-clip overflow-y-auto rounded-lg border p-6 shadow-lg duration-200 outline-none sm:max-w-lg",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          // v1.4.27 — widen the icon-only close-X tap target
          // to a 36 px floor per WCAG 2.5.8 minimum target size.
          // 36 px (not 44 px) is the intentional exception for fixed
          // icon-only close affordances per Decision I — 44 px would
          // crowd the dialog header out of proportion.
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="ring-offset-background focus-visible:border-ring focus-visible:ring-ring/50 text-muted-foreground hover:bg-accent hover:text-foreground absolute top-3 right-4 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none sm:min-h-9 sm:min-w-9 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            {/* v1.4.34 — read `common.close` so screen readers
                hear the localised label instead of literal English. */}
            <span className="sr-only">{t("common.close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 pr-9 text-left", className)}
      {...props}
    />
  );
}

/**
 * The dialog's actions, laid out by `ActionPair`: at most two buttons, equal
 * width, at the right edge, a "⋯" `ActionMenu` at the left for the rest.
 */
function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  const { t } = useTranslations();
  return (
    <div data-slot="dialog-footer" className={cn("flex", className)} {...props}>
      <ActionPair>
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close asChild>
            <Button variant="outline">{t("common.close")}</Button>
          </DialogPrimitive.Close>
        )}
      </ActionPair>
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
