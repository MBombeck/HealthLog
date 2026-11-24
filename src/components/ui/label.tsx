"use client";

import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Form label. The trailing colon is an `::after` on the label itself; pass
 * `noColon` where the label is not followed by its field.
 *
 * The label starts on the reading edge, like the text and the controls
 * around it (UI standards §2, §13). It carried `pl-1` from the first
 * release, so every field name sat 4 px right of the sentence above it and
 * of a switch's name in the same card, which `SwitchRow` had to undo.
 *
 * A label that already ends in punctuation takes no colon: a field named by
 * a question read "What are you tracking for?:". The label knows its own
 * text, so the call site does not have to remember.
 *
 * The label is `inline-block`, not `inline-flex`. In a flex box the colon is
 * a flex item of its own, so a label that wraps (a long German or French
 * field name in a narrow column) left the colon floating beside the whole
 * text block instead of after the last word. In inline flow the colon is
 * glued to the last word and wraps with it. A call site that lays out a name
 * beside a unit sets `flex` itself and owns the colon there.
 */
const ENDS_IN_PUNCTUATION = /[?!.:;\u2026\uFF1F\uFF01\uFF1A\u3002]\s*$/;

function Label({
  className,
  noColon = false,
  children,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & { noColon?: boolean }) {
  const withoutColon =
    noColon ||
    (typeof children === "string" && ENDS_IN_PUNCTUATION.test(children));
  return (
    <LabelPrimitive.Root
      data-slot="label"
      data-no-colon={withoutColon}
      className={cn(
        "inline-block text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 after:content-[':'] data-[no-colon=true]:after:content-none",
        className,
      )}
      {...props}
    >
      {children}
    </LabelPrimitive.Root>
  );
}

export { Label };
