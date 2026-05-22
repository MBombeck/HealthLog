import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Base textarea primitive — mirror of `<Input>` for multi-line input.
 *
 * v1.4.47 W2 — extracted the iOS-zoom defence + tap-target floor +
 * autocomplete defaults that the bugreport / medications-import /
 * side-effects / admin-feedback textareas were copy-pasting into a
 * single primitive. Six call sites previously each maintained their
 * own className string; any drift between them was a paper-cut waiting
 * to happen.
 *
 * What it bakes in:
 *
 *   - `text-base sm:text-sm` — iOS Safari zooms the viewport on
 *     focus when the font-size renders below 16 px, which yanks the
 *     keyboard up and leaves the user lost. 16 px on mobile holds
 *     the viewport; 14 px on `sm`+ keeps the compact desktop look.
 *
 *   - `min-h-11 sm:min-h-9` — WCAG 2.5.5 / Apple HIG floor of 44 px
 *     on touch screens, shrinking to 36 px once we know we have a
 *     pointer (covers `rows={1}` single-line uses without dropping
 *     under the tap-target floor).
 *
 *   - `autoCapitalize="sentences"` — free-text fields read as prose
 *     on iOS / Android by default. Caller can override with `"none"`
 *     for code / JSON / IDs.
 *
 *   - `spellCheck` defaults to `true` — same reasoning.
 *
 *   - `autoComplete` defaults to `"off"` for the same reason as
 *     `<Input>`: HealthLog is a health-data app, and we don't want
 *     a password manager pasting the user's saved password into a
 *     free-text textarea that we then persist server-side. Caller
 *     can opt back in (e.g. `"on"`) per field.
 *
 * Composition is via `cn(…)` so callers can override anything — the
 * primitive defaults are the strict pass, not the only pass.
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(function Textarea(
  { className, autoComplete, autoCapitalize, spellCheck, ...props },
  ref,
) {
  const resolvedAutoComplete = autoComplete ?? "off";
  const resolvedAutoCapitalize = autoCapitalize ?? "sentences";
  const resolvedSpellCheck = spellCheck ?? true;
  const skipAutofill = resolvedAutoComplete === "off";

  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      autoComplete={resolvedAutoComplete}
      autoCapitalize={resolvedAutoCapitalize}
      spellCheck={resolvedSpellCheck}
      data-lpignore={skipAutofill ? "true" : undefined}
      data-1p-ignore={skipAutofill ? "true" : undefined}
      className={cn(
        // iOS zoom defence + WCAG 2.5.5 tap-target floor; see the
        // primitive's docblock for the full reasoning.
        "border-input bg-background text-foreground placeholder:text-muted-foreground dark:bg-input/30 min-h-11 w-full rounded-md border px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9 sm:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
});

export { Textarea };
