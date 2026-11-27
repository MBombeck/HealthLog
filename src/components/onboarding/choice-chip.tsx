"use client";

import type { ReactNode } from "react";
import { Check, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The one choice row of the setup flows (1.50): a real radio or checkbox
 * inside a label, so the browser owns selection, grouping and keyboard
 * movement, and the row is only the paint. The same shape as the cadence
 * rows of the medication wizard: `rounded-lg`, the name and at most one line
 * under it, border and tint in primary when chosen, and a check on the
 * right, so the choice does not hang on colour alone.
 *
 * An icon is the glyph of the card the choice leads to, in foreground, with
 * no plate behind it.
 *
 * `children` render inside the chosen row, under its label: the relay's
 * confirmations, the server key's fields. They are outside the `<label>`, so
 * a click in them never toggles the row.
 */
export function ChoiceChip({
  name,
  value,
  kind,
  checked,
  onChange,
  label,
  hint,
  Icon,
  children,
}: {
  name: string;
  value: string;
  kind: "single" | "multi";
  checked: boolean;
  onChange: (value: string) => void;
  label: string;
  hint?: string;
  Icon?: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-border bg-card rounded-lg border transition-colors duration-150 ease-out motion-reduce:transition-none",
        checked ? "border-primary bg-primary/5" : "hover:border-primary/50",
      )}
      data-slot="onboarding-choice"
      data-value={value}
      data-checked={checked}
    >
      <label
        className={cn(
          "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-4 py-3 text-left",
          "has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2",
        )}
      >
        <input
          type={kind === "single" ? "radio" : "checkbox"}
          name={name}
          value={value}
          checked={checked}
          onChange={() => onChange(value)}
          className="sr-only"
        />
        {Icon ? (
          <Icon
            aria-hidden="true"
            className="text-foreground size-4 shrink-0"
          />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="text-foreground block text-sm leading-tight font-medium">
            {label}
          </span>
          {hint ? (
            <span className="text-muted-foreground mt-0.5 block text-xs">
              {hint}
            </span>
          ) : null}
        </span>
        <Check
          aria-hidden="true"
          className={cn(
            "text-primary size-4 shrink-0",
            checked ? "visible" : "invisible",
          )}
        />
      </label>
      {checked && children ? (
        <div className="space-y-3 px-4 pb-4" data-slot="onboarding-choice-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}
