"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * v1.4.27 MB7 / CF-52 — shared `<select>` primitive.
 *
 * Three settings/admin surfaces (`AccountSection`, `TimezonePicker`,
 * `GeneralSettingsSection`) each declared a local `NATIVE_SELECT_CLASS`
 * constant that traced the same visual contract as the shadcn
 * `<SelectTrigger>` (border + bg + ring tokens, focus vocabulary).
 * The three copies had drifted slightly — one dropped `w-full`,
 * another dropped the `shadow-xs` token — so the three forms rendered
 * at subtly different weights despite reading "the same select" to
 * the user.
 *
 * The primitive collapses the duplicates. Consumers wrap it like a
 * raw `<select>` and the className still composes via `cn(...)` so
 * site-specific tweaks (`sm:max-w-sm`, etc.) keep working.
 *
 * Height: `h-10` (40 px) — matches the v1.4.27 tap-target floor on
 * `<Input>` and `<SelectTrigger>` (MB2). The legacy `h-9` (36 px)
 * the three call sites carried was the pre-v1.4.27 contract; the
 * primitive extraction lands at the new floor so every form input on
 * the same row reads at the same height.
 *
 * Why native? The shadcn `<Select>` from `@radix-ui/react-select` is
 * the better keyboard experience on desktop but pulls in extra
 * client JS and does not show the iOS / Android native picker.
 * Settings/admin surfaces benefit from the native picker (especially
 * for the 400-entry timezone list) so we deliberately stay on
 * `<select>` here. The styled primitive keeps the visual rhythm
 * uniform with the rest of the form's `<Input>` + `<SelectTrigger>`
 * rows.
 */
const NATIVE_SELECT_CLASS =
  "border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none";

export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  NativeSelectProps
>(function NativeSelect({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      data-slot="native-select"
      className={cn(NATIVE_SELECT_CLASS, className)}
      {...props}
    >
      {children}
    </select>
  );
});
