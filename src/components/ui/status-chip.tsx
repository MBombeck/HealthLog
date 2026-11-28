"use client";

import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * `<StatusChip>` — the one status display for a thing that can work or
 * fail (an integration, a delivery channel, a module, a token) and for a run
 * (an import, an export): a dot and one of five words.
 *
 * - **Active**: set up, switched on, the last run went through.
 * - **Error**: set up, but nothing arrives or nothing goes out. The reason
 *   stands as a meta line beside the chip, never inside it.
 * - **Off**: not set up, paused, or switched off.
 * - **Running**: a run is under way (info).
 * - **Done**: a run finished (success).
 *
 * Settings used to say this five ways ("Working", "On", "Active",
 * "Auto-disabled", a red sentence in place of a badge), and Telegram, ntfy,
 * Webhook and Email said nothing at all. The word comes from
 * `common.status.*`, so a surface cannot invent a sixth; the guard
 * `status-chip-guard.test.ts` refuses a hand-rolled status badge under
 * `src/components` and `src/app`.
 *
 * The chip is never clickable and never purple. Colour is never the only
 * signal: the word is the accessible name. "Error" is the solid destructive
 * badge, because red text on a red wash falls below AA in both themes.
 */
export type StatusChipTone = "active" | "error" | "off" | "running" | "done";

const TONE: Record<StatusChipTone, string> = {
  active: "border-success/30 bg-success/15 text-success",
  error: "",
  off: "border-border text-muted-foreground",
  running: "border-info/30 bg-info/15 text-info",
  done: "border-success/30 bg-success/15 text-success",
};

export function StatusChip({
  tone,
  className,
  ...props
}: {
  tone: StatusChipTone;
  className?: string;
} & Omit<React.ComponentProps<typeof Badge>, "variant" | "children">) {
  const { t } = useTranslations();
  // Literal keys, one per tone, so the call-site coverage guard sees each.
  const word: Record<StatusChipTone, string> = {
    active: t("common.status.active"),
    error: t("common.status.error"),
    off: t("common.status.off"),
    running: t("common.status.running"),
    done: t("common.status.done"),
  };
  return (
    <Badge
      data-slot="status-chip"
      data-tone={tone}
      variant={tone === "error" ? "destructive" : "outline"}
      className={cn("gap-1.5", TONE[tone], className)}
      {...props}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {word[tone]}
    </Badge>
  );
}
