"use client";

import { type FormEvent, type KeyboardEvent, useCallback } from "react";
import { Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.20 phase B2b — Coach composer.
 *
 * `<textarea>` wrapped in a Dracula-styled card with a send button.
 * Submit fires on:
 *   - Enter (no Shift) → send
 *   - Cmd/Ctrl + Enter → send (parity with the artboard ⌘↵ chip)
 *   - Shift + Enter → newline (default browser behaviour)
 *
 * The composer is purely controlled — `value` + `onChange` come from
 * the drawer. `disabled` flips during a streamed reply so we never
 * fire two requests in parallel.
 *
 * v1.4.22 B4: the disclaimer ("Coach replies are generated …") moved
 * out of the composer and into the sources rail footer, so the
 * composer stays focused on the input affordance.
 *
 * v1.4.25 W5: dropped the non-functional mic icon. The voice-input
 * affordance ships with the iOS client; surfacing a placeholder in the
 * web composer drew clicks for an action that did nothing.
 */
export interface CoachInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  /** Disabled while a previous reply is still streaming. */
  disabled?: boolean;
  /** Surfaces the streaming-in-progress affordance on the send button. */
  isStreaming?: boolean;
  /** Optional textarea ref so the parent can focus on drawer open. */
  inputId?: string;
}

export function CoachInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  isStreaming = false,
  inputId = "coach-composer-textarea",
}: CoachInputProps) {
  const { t } = useTranslations();

  const canSubmit = !disabled && value.trim().length > 0;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Shift+Enter inserts a newline; plain Enter and ⌘/Ctrl+Enter submit.
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      if (canSubmit) onSubmit();
    },
    [canSubmit, onSubmit],
  );

  const handleFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (canSubmit) onSubmit();
    },
    [canSubmit, onSubmit],
  );

  return (
    <form
      data-slot="coach-input"
      onSubmit={handleFormSubmit}
      className="flex flex-col"
    >
      <div
        className={cn(
          "border-border/60 bg-muted/40 group rounded-md border",
          "p-2.5 transition-colors",
          "focus-within:border-dracula-purple/50 focus-within:ring-dracula-purple/15 focus-within:ring-2",
        )}
      >
        <textarea
          id={inputId}
          data-slot="coach-input-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("insights.coach.composerPlaceholder")}
          disabled={disabled}
          rows={2}
          className={cn(
            "w-full resize-none bg-transparent text-sm leading-relaxed outline-none",
            "placeholder:text-muted-foreground disabled:opacity-60",
          )}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span
            data-slot="coach-input-hint"
            className="text-muted-foreground text-[11px]"
          >
            {t("insights.coach.composerHint")}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
            data-slot="coach-input-send"
            className="ml-auto gap-1.5"
          >
            {isStreaming ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="size-3.5" aria-hidden="true" />
            )}
            <span>{t("insights.coach.send")}</span>
          </Button>
        </div>
      </div>
    </form>
  );
}
