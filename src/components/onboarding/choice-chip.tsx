"use client";

import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One answer chip of a setup question: a real radio or checkbox inside a
 * label, so the browser owns selection, grouping and keyboard movement
 * (arrow keys across a radio group, space on a checkbox), and the chip is
 * only the paint.
 *
 * The input is visually hidden and the label carries the focus ring through
 * `has-[:focus-visible]`, because a hidden control with no visible focus is
 * how a keyboard user loses their place in a chip grid — the five-step
 * wizard's picker had exactly that gap.
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
}: {
  name: string;
  value: string;
  kind: "single" | "multi";
  checked: boolean;
  onChange: (value: string) => void;
  label: string;
  hint?: string;
  Icon?: LucideIcon;
}) {
  return (
    <label
      className={cn(
        "border-border bg-card flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors duration-150 ease-out motion-reduce:transition-none",
        "hover:border-primary/50",
        "has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2",
        checked && "border-primary bg-primary/5",
      )}
      data-slot="onboarding-choice"
      data-value={value}
      data-checked={checked}
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
        <span
          aria-hidden="true"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
            checked
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
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
    </label>
  );
}
