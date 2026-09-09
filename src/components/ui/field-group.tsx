import type { ReactNode } from "react";

import { FieldError } from "@/components/forms/field-error";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Central form field-group primitive: one label-above-control rhythm so every
 * add form reads with the same vertical spacing. Mirrors the long-standing
 * `space-y-2` + `<Label htmlFor>` + control idiom byte-for-byte so adopting it
 * is a no-op on rendered output.
 *
 * - `hint` renders below the control as muted fine print.
 * - `error` renders below the hint as the field's own error slot, with
 *   the id `<htmlFor>-error` so the control can point
 *   `aria-describedby` at it.
 * - `labelAccessory` sits right-aligned in the label row (e.g. a char counter);
 *   when present the label row becomes a `justify-between` flex row.
 */
export function FieldGroup({
  htmlFor,
  label,
  hint,
  error,
  labelAccessory,
  className,
  labelClassName,
  children,
}: {
  htmlFor: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  labelAccessory?: ReactNode;
  className?: string;
  labelClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {labelAccessory ? (
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={htmlFor} className={labelClassName}>
            {label}
          </Label>
          {labelAccessory}
        </div>
      ) : (
        <Label htmlFor={htmlFor} className={labelClassName}>
          {label}
        </Label>
      )}
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      <FieldError id={`${htmlFor}-error`} message={error} />
    </div>
  );
}
