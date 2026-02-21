"use client";

import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Label({
  className,
  noColon = false,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & { noColon?: boolean }) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      data-no-colon={noColon}
      className={cn(
        "inline-flex items-center pl-1 text-sm leading-none font-medium select-none after:content-[':'] data-[no-colon=true]:after:content-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
