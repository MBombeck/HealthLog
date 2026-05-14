"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
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

/**
 * v1.4.25 W5 — Claude-web-style auto-grow.
 *
 * The composer textarea starts at 1 line (≈44 px including padding,
 * matching the disclaimer text height on the sources rail) and grows
 * with content up to 6 lines (≈144 px). Past 6 lines the textarea
 * scrolls internally. Implemented as a plain `scrollHeight` measurement
 * — no external auto-resize library, no `contenteditable` round-trip,
 * no `field-sizing` (still Chrome-only in 2026-Q2).
 *
 * Pure helper so the math can be unit-tested without a DOM:
 *   - `lineHeight`: cached line-height of the textarea (px)
 *   - `scrollHeight`: textarea's natural `scrollHeight` after height
 *     was reset to "auto"
 *   - `maxLines`: hard cap (6); past this the textarea scrolls
 * Returns the height in px to apply, clamped to [minHeight, maxHeight].
 */
export function computeAutoGrowHeight(args: {
  lineHeight: number;
  scrollHeight: number;
  maxLines: number;
  paddingY: number;
}): number {
  const min = args.lineHeight + args.paddingY;
  const max = args.lineHeight * args.maxLines + args.paddingY;
  // Honour the existing scrollHeight (which already includes padding)
  // but clamp it into the [min,max] band. The minimum guarantees the
  // textarea never collapses below a single line when the value is
  // empty; the maximum prevents the row from pushing the composer
  // taller than 6 lines.
  return Math.max(min, Math.min(args.scrollHeight, max));
}

const AUTO_GROW_MAX_LINES = 6;

export function CoachInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  isStreaming = false,
  inputId = "coach-composer-textarea",
}: CoachInputProps) {
  const { t } = useTranslations();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // v1.4.25 W5 — auto-grow side effect. Runs on every value change
  // (the controlled `value` prop is the source of truth) plus on mount
  // so the initial paint already shows the 1-line height even when the
  // value arrives prefilled. We reset `style.height` to "auto" first so
  // shrinking text (e.g. after the user hits send) also collapses the
  // textarea — without the reset, `scrollHeight` only ever monotonically
  // grows. Reads `getComputedStyle` for line-height + padding once per
  // tick so a CSS-only theme change re-applies the right minimum.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Reset so the browser re-measures the natural content height.
    el.style.height = "auto";
    const computed = window.getComputedStyle(el);
    const rawLineHeight = parseFloat(computed.lineHeight);
    const lineHeight = Number.isFinite(rawLineHeight) ? rawLineHeight : 20;
    const paddingY =
      (parseFloat(computed.paddingTop) || 0) +
      (parseFloat(computed.paddingBottom) || 0);
    const height = computeAutoGrowHeight({
      lineHeight,
      scrollHeight: el.scrollHeight,
      maxLines: AUTO_GROW_MAX_LINES,
      paddingY,
    });
    el.style.height = `${height}px`;
  }, [value]);

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
          ref={textareaRef}
          data-slot="coach-input-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("insights.coach.composerPlaceholder")}
          disabled={disabled}
          // v1.4.25 W5 — single-line initial state, Claude-web-style.
          // `rows={1}` is the SSR-stable baseline; the `useEffect`
          // above grows the textarea up to `AUTO_GROW_MAX_LINES`. Past
          // the cap the textarea scrolls internally (overflow-auto via
          // `max-h-[9.5rem]`, ≈6 lines at the current line-height).
          rows={1}
          className={cn(
            "w-full resize-none bg-transparent text-sm leading-relaxed outline-none",
            "max-h-[9.5rem] overflow-auto",
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
