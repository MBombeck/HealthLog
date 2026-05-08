import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Pulsing placeholder used while data is loading. Wrap text-equivalent
 * shapes so the page does not jump when real content arrives. Honours
 * `prefers-reduced-motion` automatically because Tailwind's
 * `animate-pulse` is disabled by `motion-reduce:animate-none`.
 *
 * Pattern: render the same layout the loaded UI will render, with each
 * dynamic block replaced by a `<Skeleton className="h-X w-Y" />`.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      role="presentation"
      aria-hidden="true"
      className={cn(
        "bg-muted/60 animate-pulse rounded-md motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
