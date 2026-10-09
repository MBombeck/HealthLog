"use client";

import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { isApplePlatform } from "@/lib/keyboard/global-shortcuts";

import { openCommandPalette, preloadCommandPalette } from "./palette-store";

/**
 * The way into the command palette, at the trailing end of the top bar on
 * every signed-in page. Where the bar has room it looks like a search field
 * ("Search…" and the key that opens it); where it has not (a phone, or a
 * desktop bar narrowed by the sidebar and a docked panel) it is a magnifier
 * with a tooltip. The switch reads the bar's own width (`@container/topbar`
 * on the header), not the window's, because a docked panel takes the room
 * without the window changing.
 */
export function CommandPaletteTrigger() {
  const { t } = useTranslations();
  // The key hint depends on the platform, which the server cannot know.
  const mounted = useMounted();
  const apple = mounted && isApplePlatform();
  const label = t("palette.openLabel");
  const keyHint = apple ? "⌘K" : "Ctrl K";
  const shortcut = apple ? "Meta+K" : "Control+K";

  return (
    <div className="ml-auto flex shrink-0 items-center">
      <button
        type="button"
        data-slot="command-palette-trigger"
        data-variant="field"
        aria-label={label}
        aria-keyshortcuts={mounted ? shortcut : undefined}
        aria-haspopup="dialog"
        onClick={openCommandPalette}
        onPointerEnter={preloadCommandPalette}
        onFocus={preloadCommandPalette}
        className="border-border bg-background text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring/50 hidden h-9 w-56 items-center gap-2 rounded-md border px-3 text-sm transition-colors outline-none focus-visible:ring-[3px] @2xl/topbar:flex"
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate text-left">{t("palette.open")}</span>
        {mounted ? (
          <kbd
            aria-hidden="true"
            className="border-border bg-muted text-foreground rounded border px-1.5 font-mono text-xs"
          >
            {keyHint}
          </kbd>
        ) : null}
      </button>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-slot="command-palette-trigger"
              data-variant="icon"
              aria-label={label}
              aria-keyshortcuts={mounted ? shortcut : undefined}
              aria-haspopup="dialog"
              onClick={openCommandPalette}
              onPointerEnter={preloadCommandPalette}
              onFocus={preloadCommandPalette}
              className="text-muted-foreground hover:text-foreground min-h-11 min-w-11 @2xl/topbar:hidden"
            >
              <Search className="size-5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
