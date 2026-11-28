import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The rare inline hint: a sentence that has to stand on the surface because
 * hiding it behind an (i) would let someone get it wrong.
 *
 * Three reasons only, and the call site names which (UI standards, text
 * rule 2): `safety` (something is deleted, revoked or irreversible, a secret
 * is shown once, data leaves the server), `consent` (the reader is agreeing
 * to something), `operation` (the control would be used wrongly without the
 * sentence). Everything else is deleted or moves behind `InfoPopover`.
 *
 * Like the (i) trigger it carries `data-slot="hint"`, so the per-route
 * explainer budget in `e2e/text-budgets.json` counts it, and the lint rule
 * `healthlog/no-free-hint` refuses a muted paragraph written beside it.
 */
export function Hint({
  reason,
  className,
  ...props
}: React.ComponentProps<"p"> & {
  reason: "safety" | "consent" | "operation";
}) {
  return (
    <p
      data-slot="hint"
      data-hint-reason={reason}
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}
