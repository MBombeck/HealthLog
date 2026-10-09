"use client";

/**
 * The timeline's own life-event sheet (v1.42, #613): add from the header
 * button or a readiness link, edit from a life event in the chronicle or the
 * selection bar. A bottom sheet on a phone, a dialog above.
 */
import { useState } from "react";

import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import type { LifeEventDTO } from "@/lib/day/contract";
import { useTranslations } from "@/lib/i18n/context";

import { LifeEventForm } from "./life-event-form";

export function LifeEventSheet({
  open,
  onOpenChange,
  event,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: LifeEventDTO | null;
}) {
  const { t } = useTranslations();
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const close = () => onOpenChange(false);
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={event ? t("lifeEvents.edit") : t("lifeEvents.title")}
      contentWidth="lg"
      footer={<div ref={setFooter} className="flex w-full" />}
    >
      {open && (
        <LifeEventForm
          // A different event remounts the form with its own draft.
          key={event?.id ?? "new"}
          event={event}
          onSuccess={close}
          onCancel={close}
          footerSlot={footer}
        />
      )}
    </ResponsiveSheet>
  );
}
