"use client";

import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Form label. A field name, never followed by a colon: the field sits under
 * or beside its name, and the colon was one more mark on every line of every
 * sheet. It used to be an `::after` here with a `noColon` opt-out, which left
 * half the labels with one and half without; there is now no colon and no
 * switch. Guard: `label-colon-guard.test.tsx`.
 *
 * The label starts on the reading edge, like the text and the controls
 * around it (UI standards §2, §13). A field is named by a noun, never a
 * question (`form-label-wording-guard.test.ts`).
 *
 * The label is `inline-block`; a call site that lays out a name beside a unit
 * sets `flex` itself.
 */
function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "inline-block text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
