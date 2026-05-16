import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Base input primitive.
 *
 * v1.4 hardening: defaults `autoComplete` to `"off"` and tells
 * LastPass / 1Password to skip the field when the caller does not
 * opt in to a semantic autocomplete value. HealthLog is a health-data
 * app — letting browsers / password managers autofill measurement,
 * medication, mood, and AI-token inputs with the user's last-saved
 * email or account password is at best confusing and at worst leaks
 * credentials into a free-text field that gets persisted server-side.
 *
 * Auth and profile forms (login, register, change-email) keep working
 * because they already pass an explicit `autoComplete` value —
 * `"username"`, `"email"`, `"current-password"`, `"new-password"`. When
 * `autoComplete` is anything other than `"off"`, the LastPass /
 * 1Password ignore attrs are dropped so password managers fill the
 * field normally.
 *
 * v1.4.27 mobile pass: derive a sensible `inputMode` default from the
 * `type` prop so every numeric / email / tel / url / search field
 * surfaces the right on-screen keyboard on iOS Safari and Android
 * Chrome without each call site having to repeat the attribute. Most
 * `type="number"` fields in HealthLog accept decimals (kg, mmol/L,
 * sleep hours), so the default is `"decimal"`; integer-only call
 * sites can still pass `inputMode="numeric"` explicitly.
 */
function deriveInputMode(
  type: React.HTMLInputTypeAttribute | undefined,
): React.HTMLAttributes<HTMLInputElement>["inputMode"] | undefined {
  switch (type) {
    case "number":
      return "decimal";
    case "tel":
      return "tel";
    case "email":
      return "email";
    case "url":
      return "url";
    case "search":
      return "search";
    default:
      return undefined;
  }
}

function Input({
  className,
  type,
  autoComplete,
  inputMode,
  ...props
}: React.ComponentProps<"input">) {
  const resolvedAutoComplete = autoComplete ?? "off";
  const skipAutofill = resolvedAutoComplete === "off";
  const resolvedInputMode = inputMode ?? deriveInputMode(type);

  return (
    <input
      type={type}
      data-slot="input"
      autoComplete={resolvedAutoComplete}
      inputMode={resolvedInputMode}
      data-lpignore={skipAutofill ? "true" : undefined}
      data-1p-ignore={skipAutofill ? "true" : undefined}
      className={cn(
        // v1.4.34 IW-G — floor at 44 px on mobile to clear WCAG 2.5.5;
        // shrink to 40 px on sm+ where pointer precision is higher.
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-11 sm:h-10 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
