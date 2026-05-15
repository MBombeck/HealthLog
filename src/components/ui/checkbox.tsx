"use client";

import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * v1.4.27 R3d MB4 / CF-40 — shadcn-style `<Checkbox>` primitive backed
 * by `radix-ui`'s `Checkbox` namespace. Brought in so the Coach
 * sources-rail can drop its raw `<input type="checkbox">` for a
 * keyboard + touch accessible control that ships proper focus rings
 * and a 44 px hit target on mobile.
 *
 * Mirrors the v1.4.27 shadcn `<Checkbox>` recipe: a Root that draws
 * the border + checked-state background, an Indicator slot that
 * shows the lucide `<Check>` when the box is checked.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer border-border/70 size-4 shrink-0 rounded border",
        "data-[state=checked]:bg-dracula-purple data-[state=checked]:border-dracula-purple data-[state=checked]:text-background",
        "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "transition-colors",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <Check className="size-3" aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
