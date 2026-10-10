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
 * every signed-in page: a magnifier at every width, named "Search", with a
 * tooltip that gives the key that opens it as well ("Search (⌘K)", or
 * "Search (Ctrl K)" off Apple platforms). 44 px under a coarse pointer, 36 px
 * beside a fine one. Docked panels' strips stand right of the top bar, so the
 * magnifier always sits just left of them and nothing covers it.
 */
export function CommandPaletteTrigger() {
  const { t } = useTranslations();
  // The key hint depends on the platform, which the server cannot know.
  const mounted = useMounted();
  const apple = mounted && isApplePlatform();
  const label = t("palette.title");
  const keyHint = apple ? "⌘K" : "Ctrl K";
  const shortcut = apple ? "Meta+K" : "Control+K";

  return (
    <div className="ml-auto flex shrink-0 items-center">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-slot="command-palette-trigger"
              aria-label={label}
              aria-keyshortcuts={mounted ? shortcut : undefined}
              aria-haspopup="dialog"
              onClick={openCommandPalette}
              onPointerEnter={preloadCommandPalette}
              onFocus={preloadCommandPalette}
              className="text-muted-foreground hover:text-foreground size-11 pointer-fine:size-9"
            >
              <Search className="size-5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" data-slot="command-palette-tooltip">
            {mounted ? `${label} (${keyHint})` : label}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
