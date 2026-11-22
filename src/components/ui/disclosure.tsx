import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A line that opens to show more: "What the relay sees", "Included data",
 * "Skipped rows". One look for all of them: the label on the left, a chevron
 * on the right that turns when open, a 44 px row on a phone.
 *
 * It is the browser's own `<details>`, so it opens without script, is found
 * by the page search and announces its state. What it replaces is the bare
 * `<details>` with the browser's triangle, which sat beside four dozen
 * chevron rows built from a ghost button and looked like a different app.
 *
 * `framed` draws a border around the row and its content, for a disclosure
 * that stands on its own in a card body. Without it the row sits flush in
 * whatever holds it.
 */
export function Disclosure({
  summary,
  framed = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"details">, "children"> & {
  summary: React.ReactNode;
  framed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      data-slot="disclosure"
      className={cn(
        "group/disclosure",
        framed && "border-border rounded-md border px-3",
        className,
      )}
      {...props}
    >
      <summary className="focus-visible:ring-ring/50 flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md text-sm font-medium outline-none focus-visible:ring-[3px] sm:min-h-9 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">{summary}</span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-open/disclosure:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className={cn("space-y-2 text-sm", framed ? "pb-3" : "pt-1")}>
        {children}
      </div>
    </details>
  );
}
