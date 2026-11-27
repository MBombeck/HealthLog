"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * A switch with its name and, when it needs one, a sentence about what it
 * does. The name is on the left, the switch on the right of the same line at
 * every width.
 *
 * Five shapes did this job: the switch under the title, the switch in a row
 * of its own below the text on a phone (Admin), a name with a colon and a
 * 14 px description (Cycle), a `<label>` wrapped around a span and the
 * switch, and a bare `Label` beside it. They disagreed on where the switch
 * stands, whether the name ends in a colon and how large the description is.
 *
 * What this owns:
 *
 * - **The place of the switch**: right, vertically centred on the row, at
 *   every width, whether the row is one line or carries a description. It
 *   never drops under the text. (It used to top-align with the name once a
 *   description was present, so a card mixing both kinds of row had its
 *   switches on two different lines.)
 * - **The name**: a `Label` bound to the switch, `text-sm font-medium`, no
 *   colon (it names a choice, it does not caption a field).
 * - **The description**: one muted `text-xs` line, announced with the switch.
 * - **The icon**, when the row has one: muted, beside the name.
 *
 * Every other prop goes to the switch itself (`id`, `checked`,
 * `onCheckedChange`, `disabled`, `aria-*`, `data-*`), so a row is written
 * the way a switch is. `className` is the row's, for a list that pads its
 * rows. `children` are further lines under the description (a note on why
 * the switch is locked, a link to a fuller page).
 *
 * The one other place a switch may stand is a card header's `status` slot,
 * for a switch that turns the whole card on or off.
 */
export function SwitchRow({
  label,
  description,
  icon: Icon,
  className,
  children,
  id,
  ...switchProps
}: Omit<React.ComponentProps<typeof Switch>, "children" | "className"> & {
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
  children?: React.ReactNode;
}) {
  const generatedId = React.useId();
  const switchId = id ?? generatedId;
  const descriptionId = description ? `${switchId}-description` : undefined;
  return (
    <div
      data-slot="switch-row"
      className={cn("flex items-center justify-between gap-4", className)}
    >
      <div className="flex min-w-0 items-start gap-3">
        {Icon ? (
          <Icon
            className="text-muted-foreground mt-0.5 size-5 shrink-0"
            aria-hidden="true"
          />
        ) : null}
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={switchId} className="leading-snug">
            {label}
          </Label>
          {description ? (
            <p id={descriptionId} className="text-muted-foreground text-xs">
              {description}
            </p>
          ) : null}
          {children}
        </div>
      </div>
      <Switch
        id={switchId}
        aria-describedby={descriptionId}
        {...switchProps}
        className="shrink-0"
      />
    </div>
  );
}
