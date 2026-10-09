"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * New conversation, as the round button in the conversation's own window:
 * the floating Coach button's size and look, with a plus.
 *
 * It sits in the composer's row, so it belongs to the conversation and never
 * to the list beside it, and it moves wherever that column goes (a docked
 * list or day narrows the column, the button stays inside it). Where the
 * column is wide enough, it takes the bottom right corner beside the
 * composer, where the Coach button sits on other pages; where the composer
 * fills the width (a phone, the drawer, a narrow column), it rises just
 * above the composer's top edge so it never covers the field.
 *
 * The parent is the composer's wrapper and must be `relative` and an
 * `@container/composer`.
 */
export function NewChatFab({
  onNewChat,
  className,
}: {
  onNewChat: () => void;
  className?: string;
}) {
  const { t } = useTranslations();
  const label = t("insights.coach.newConversation");
  return (
    <Button
      type="button"
      size="icon"
      data-slot="coach-new-chat-fab"
      // Steps aside while the on-screen keyboard is open (globals.css).
      data-keyboard-hide=""
      onClick={onNewChat}
      aria-label={label}
      title={label}
      className={cn(
        "absolute right-4 bottom-full z-10 mb-3 size-14 rounded-full shadow-lg sm:right-6",
        // Beside the capped composer, in the column's bottom right corner.
        "@min-[54rem]/composer:right-8 @min-[54rem]/composer:bottom-8 @min-[54rem]/composer:mb-0",
        // The Coach button's face: a dark glyph on the brand gradient.
        "from-primary to-brand-pink text-background bg-gradient-to-br",
        "hover:from-primary/90 hover:to-brand-pink/90",
        "focus-visible:ring-offset-background focus-visible:ring-offset-2",
        className,
      )}
    >
      <Plus className="text-background size-6" aria-hidden="true" />
    </Button>
  );
}
