import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * v1.4.33 — loading-state convention.
 *
 * Callers driving a transient loading state on a button must SWAP the
 * leading icon for `<Loader2 />` rather than APPENDING the spinner
 * next to the existing icon. The legacy `{loading && <Loader2/>}<Icon/>`
 * pattern grew the button by ~24 px during the request, which produced
 * the 0.186 CLS hit flagged on the v1.4.33 Lighthouse run. The
 * spinner and the icon are both 16 px (`h-4 w-4`); swapping keeps the
 * intrinsic button width stable.
 *
 *   ```tsx
 *   <Button disabled={loading} aria-busy={loading || undefined}>
 *     {loading ? (
 *       <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
 *     ) : (
 *       <Icon className="h-4 w-4" />
 *     )}
 *     {label}
 *   </Button>
 *   ```
 *
 * Also: pass `aria-busy={loading || undefined}` so screen readers
 * announce the in-flight state.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // Disabled keeps its label readable in both themes: a token pair
        // rather than half opacity (white on a washed violet, ~2:1 light).
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-primary-disabled disabled:text-primary-disabled-foreground disabled:opacity-100",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        // The quiet pair, for a list whose rows each carry their own two
        // actions (the start page's asks): `neutral` is the secondary, a
        // grey fill with foreground text; `tonal` is the primary, the accent
        // at a tenth with accent text. Both filled, neither framed, same
        // size, so the pair reads as one control and the primary differs
        // by colour alone, never by weight or outline (UI standards §15).
        neutral: "bg-muted text-foreground hover:bg-muted/70",
        tonal:
          "bg-primary/10 text-primary hover:bg-primary/15 dark:bg-primary/15 dark:hover:bg-primary/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3 pointer-coarse:min-h-11",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        lg: "h-11 rounded-md px-6 has-[>svg]:px-4",
        // A 32 px face with a 44 px target: the target grows 6 px above and
        // below through `::before`, so a row of these stays compact and still
        // meets 44 px under a finger. No `pointer-coarse:min-h-11`: that would
        // grow the face itself back to 44 px on a touch screen.
        compact:
          "relative h-8 gap-1 rounded-md px-1.5 text-xs before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']",
        icon: "size-10 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
