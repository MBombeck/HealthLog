"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  FolderOpen,
  Loader2,
  Paperclip,
  Send,
  Square,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

import { COACH_COMPOSER_ID } from "./composer-focus";

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
 * out of the composer and into the sources rail footer. DISC-01
 * (v1.18.6) later dropped that per-page copy too, in favour of the
 * one-time onboarding acknowledgment; the only in-surface "not medical
 * advice" text left in this namespace is `errorNoProvider`, shown only
 * when no provider is connected. The real non-diagnostic boundary is
 * the guard stack (system prompt, prose-grounding check, outbound
 * refusal), not a rendered disclaimer line.
 *
 * New chat, the conversation list and the settings gear live in the Coach
 * page's conversations panel (and the drawer's header), not in the composer.
 *
 * Voice input was removed after repeated browser and permission failures made
 * the control unreliable. The composer now exposes only actions that work
 * consistently across supported browsers.
 */
export interface CoachInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  /**
   * Aborts the in-flight streamed reply. The composer swaps the send
   * button for a Stop control while `isStreaming` is set; tapping it
   * cancels the SSE request so the user can interrupt a long or
   * off-track reply.
   */
  onCancel?: () => void;
  /** Disabled while a previous reply is still streaming. */
  disabled?: boolean;
  /** Surfaces the streaming-in-progress affordance on the send button. */
  isStreaming?: boolean;
  /** Optional textarea ref so the parent can focus on drawer open. */
  inputId?: string;
  /**
   * v1.4.27 MB3 / CF-30 — when set, focuses the composer textarea once
   * on mount. The drawer flips this to `true` when the drawer becomes
   * the freshly-opened surface so the user can start typing
   * immediately. It must stay opt-in (lazy): on every re-render of an
   * already-open drawer we do not steal focus back.
   */
  autoFocusOnOpen?: boolean;
  /**
   * v1.16.5 — placeholder override. The guided clarifying-questions
   * flow swaps the generic "ask anything" prompt for an answer cue
   * while a question is live. Falls back to the stock composer copy.
   */
  placeholder?: string;
  /**
   * v1.29.x (S7) — mount the document-attach trigger (a leading paperclip menu:
   * "Choose from documents" + "Upload new document"). Set by the parent only
   * when the `inboundDocuments` module is enabled for the user; hidden entirely
   * otherwise. It stages fenced document attachments; conversations are managed
   * in the page's conversations panel.
   */
  attachEnabled?: boolean;
  /**
   * v1.29.x (S7) — open the vault picker dialog. The parent owns the dialog +
   * the staged-attachment state. Required when `attachEnabled` is set.
   */
  onPickFromVault?: () => void;
  /**
   * v1.29.x (S7) — the user chose files from the "Upload new document" item.
   * The parent uploads them through the existing `/api/documents/inbound`
   * pipeline and stages the resulting documents as indexing pills.
   */
  onUploadNew?: (files: File[]) => void;
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
  onCancel,
  disabled = false,
  isStreaming = false,
  inputId = COACH_COMPOSER_ID,
  autoFocusOnOpen = false,
  placeholder,
  attachEnabled = false,
  onPickFromVault,
  onUploadNew,
}: CoachInputProps) {
  const { t } = useTranslations();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachFileInputRef = useRef<HTMLInputElement | null>(null);

  // v1.4.27 MB3 / CF-30 — focus the textarea once on mount when the
  // parent flags this surface as the freshly-opened one. The empty
  // dependency array keeps this from re-firing on every value change
  // (the auto-grow effect handles those). We bail when disabled so we
  // do not yank focus into a non-interactive field.
  useEffect(() => {
    if (!autoFocusOnOpen || disabled) return;
    const el = textareaRef.current;
    if (!el) return;
    // Defer to the next paint so the drawer's own focus-trap finishes
    // resolving before we hand the cursor to the composer.
    const id = window.requestAnimationFrame(() => {
      el.focus();
    });
    return () => window.cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on mount
  }, []);

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

  // Shared send / stop control for both page and drawer surfaces.
  const sendButton =
    isStreaming && onCancel ? (
      // While a reply streams, swap the send button for a Stop control bound
      // to the abort handler so the user can interrupt a long or off-track
      // reply instead of waiting it out.
      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={onCancel}
        data-slot="coach-input-stop"
        aria-label={t("insights.coach.stop")}
        title={t("insights.coach.stop")}
        className="size-11 shrink-0 rounded-xl sm:size-9"
      >
        <Square className="size-3.5 fill-current" aria-hidden="true" />
      </Button>
    ) : (
      <Button
        type="submit"
        size="icon"
        disabled={!canSubmit}
        data-slot="coach-input-send"
        aria-label={t("insights.coach.send")}
        title={t("insights.coach.send")}
        className="size-11 shrink-0 rounded-xl sm:size-9"
      >
        {isStreaming ? (
          <Loader2
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <Send className="size-4" aria-hidden="true" />
        )}
      </Button>
    );

  // v1.29.x (S7) — the document-attach affordance: a leading paperclip menu
  // ("Choose from documents" opens the vault picker; "Upload new document"
  // opens the file input, reusing the existing `/api/documents/inbound`
  // pipeline). Rendered only when the parent enables it (module-gated).
  const attachButton = attachEnabled ? (
    <>
      <input
        ref={attachFileInputRef}
        type="file"
        multiple
        className="hidden"
        data-slot="coach-input-attach-file"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Reset so re-selecting the same file re-fires `change`.
          event.target.value = "";
          if (files.length > 0) onUploadNew?.(files);
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            data-slot="coach-input-attach"
            aria-label={t("insights.coach.attach.trigger")}
            title={t("insights.coach.attach.trigger")}
            className="text-muted-foreground hover:text-foreground size-11 shrink-0 rounded-xl sm:size-9"
          >
            <Paperclip className="size-5 sm:size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        {/* v1.29.1 — the item labels shrink + truncate within the popover width
            (`min-w-0` + a `truncate` span) so a long localised label — e.g.
            "Neues Dokument hochladen" — can never overflow past the menu edge.
            Mirrors the vault picker items' width handling. */}
        <DropdownMenuContent align="start" side="top" className="w-60">
          <DropdownMenuItem
            data-slot="coach-input-attach-vault"
            onSelect={() => onPickFromVault?.()}
          >
            <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              {t("insights.coach.attach.menuChooseFromDocuments")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-slot="coach-input-attach-upload"
            // Defer the input click a tick so the Radix menu finishes closing
            // and returning focus before the native file dialog opens.
            onSelect={() =>
              setTimeout(() => attachFileInputRef.current?.click(), 0)
            }
          >
            <Upload className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              {t("insights.coach.attach.menuUploadNew")}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  ) : null;

  return (
    <form
      data-slot="coach-input"
      onSubmit={handleFormSubmit}
      className="flex flex-col"
    >
      <div
        className={cn(
          "border-border/60 bg-muted/40 group rounded-2xl border",
          "shadow-sm transition-colors",
          "focus-within:border-primary/50 focus-within:ring-primary/50 focus-within:bg-background focus-within:ring-2",
          // One row at every width. Mobile used to stack the controls under the
          // textarea, which made an EMPTY composer two rows tall: a 44 px line
          // plus a 44 px touch-target row plus padding, around a tenth of a
          // phone screen before anyone had typed anything. The stacking was
          // there to protect keyboard focus order, but that argument does not
          // hold: focus follows DOM order, and the DOM order (textarea,
          // actions, Send) is identical in both layouts. Nothing jumps.
          //
          // `items-center` with the controls pinned `self-end` below. The row
          // used to be `items-end` throughout, which bottom-aligned an empty
          // one-line textarea against a 44 px touch target: the placeholder sat
          // roughly 6 px low in the pill, reading as if the text had slipped.
          // Centring the textarea fixes the empty and single-line cases, and
          // `self-end` on the controls preserves the reason `items-end` was
          // there — as the textarea grows, the send button stays beside the
          // LAST line rather than drifting to the middle.
          "flex flex-row items-center gap-1.5 p-1.5",
        )}
      >
        <textarea
          id={inputId}
          ref={textareaRef}
          data-slot="coach-input-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? t("insights.coach.composerPlaceholder")}
          // Read-only rather than disabled while a reply streams: a disabled
          // field drops focus, and a follow-up chip or a clarification choice
          // hands focus here right as the turn starts.
          readOnly={disabled}
          aria-disabled={disabled || undefined}
          enterKeyHint="send"
          autoCapitalize="sentences"
          rows={1}
          className={cn(
            "order-1 w-full min-w-0 flex-1 resize-none bg-transparent text-base leading-relaxed outline-none sm:text-sm",
            "px-2 py-1.5",
            "max-h-[9.5rem] overflow-auto",
            "[scrollbar-width:thin] [scrollbar-color:color-mix(in_srgb,var(--primary)_35%,transparent)_transparent]",
            "placeholder:text-muted-foreground aria-disabled:opacity-60",
            "placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap",
          )}
        />
        <div
          data-slot="coach-input-controls"
          className="order-2 flex shrink-0 items-center gap-1.5 self-end"
        >
          <div
            data-slot="coach-input-leading"
            className="flex shrink-0 items-center gap-1.5"
          >
            {attachButton}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">{sendButton}</div>
        </div>
      </div>
    </form>
  );
}
