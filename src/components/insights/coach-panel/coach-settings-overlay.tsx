"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import { Loader2, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

// The body (model picker, the sources rail, their queries) loads when the
// gear is first opened, as one shared chunk, instead of riding along with
// every route that can mount the Coach drawer.
const CoachSettingsBody = dynamic(
  () => import("./coach-settings-body").then((m) => m.CoachSettingsBody),
  { ssr: false, loading: () => <BodyLoading /> },
);

function BodyLoading() {
  return (
    <div className="flex min-h-24 items-center justify-center">
      <Loader2
        className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * The Coach's quick settings, behind the gear: which model answers, and what
 * the Coach may read.
 *
 * A popover anchored on the gear from `md` up, a bottom sheet on a phone.
 * Both trap focus, close on Escape and hand focus back to the gear. Nothing
 * in here does model work; the provider write invalidates the AI input keys
 * and the capability comes back from the server.
 *
 * `focusData` opens it on the "What I can see" section: Settings → Coach
 * links here with `/coach?settings=data`.
 */
export interface CoachSettingsOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open on the "What I can see" section instead of the top. */
  focusData?: boolean;
  /** Classes for the gear button, so each header sizes it like its row. */
  className?: string;
}

export function CoachSettingsOverlay({
  open,
  onOpenChange,
  focusData = false,
  className,
}: CoachSettingsOverlayProps) {
  const { t } = useTranslations();
  const isPhone = useIsMobile("md");
  const gearRef = useRef<HTMLButtonElement>(null);

  const gear = (
    <Button
      ref={gearRef}
      type="button"
      variant="ghost"
      size="icon"
      data-slot="coach-settings"
      aria-label={t("insights.coach.settingsAriaLabel")}
      title={t("insights.coach.settingsAriaLabel")}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={isPhone ? () => onOpenChange(true) : undefined}
      className={cn(
        "text-muted-foreground hover:text-foreground size-11 shrink-0 pointer-fine:size-9",
        className,
      )}
    >
      <Settings className="size-4" aria-hidden="true" />
    </Button>
  );

  if (isPhone) {
    return (
      <>
        {gear}
        <ResponsiveSheet
          open={open}
          onOpenChange={onOpenChange}
          title={t("insights.coach.settingsAriaLabel")}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            gearRef.current?.focus();
          }}
        >
          <CoachSettingsBody focusData={focusData} />
        </ResponsiveSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal>
      <PopoverTrigger asChild>{gear}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        aria-labelledby="coach-settings-title"
        data-slot="coach-settings-popover"
        className="flex max-h-[min(36rem,80dvh)] w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto overscroll-contain p-4 text-sm"
        onOpenAutoFocus={(event) => {
          // The body moves focus to its data section once it has loaded.
          if (focusData) event.preventDefault();
        }}
      >
        <h2 id="coach-settings-title" className="text-base font-semibold">
          {t("insights.coach.settingsAriaLabel")}
        </h2>
        <CoachSettingsBody focusData={focusData} />
      </PopoverContent>
    </Popover>
  );
}
