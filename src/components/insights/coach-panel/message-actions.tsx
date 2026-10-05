"use client";

/**
 * The one action row under a Coach message, for both roles.
 *
 * Assistant: a single line, left-aligned. The icon actions in reading order
 * (copy, read aloud, try again, details) followed by the time the answer was
 * written. The details icon holds the model and the tokens the answer cost
 * in a tooltip that opens on hover, on keyboard focus and on a tap.
 *
 * User: copy, remember, time, flush with the bubble's right edge.
 *
 * On pointer devices the row stays quiet until its message is hovered or
 * holds focus; on touch it is always visible (there is nothing to hover).
 * `opacity-0` rather than `invisible` keeps every control focusable, and
 * focus reveals the row.
 */
import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BookmarkCheck,
  BookmarkPlus,
  Check,
  Copy,
  Info,
  Loader2,
  RotateCcw,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { resolveIntlLocale } from "@/lib/format-locale";
import type { Formatters } from "@/lib/format-locale";
import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { ABOUT_ME_FIELD_MAX_CHARS } from "@/lib/validations/about-me";

import {
  COACH_ICON_BUTTON,
  ReadAloudButton,
  useClipboardSupported,
} from "./read-aloud";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The quiet-until-hover reveal, scoped to the message's own group. */
const REVEAL = {
  assistant: cn(
    "sm:[@media(hover:hover)]:opacity-0",
    "sm:[@media(hover:hover)]:group-hover/assistant-bubble:opacity-100",
    "sm:[@media(hover:hover)]:group-focus-within/assistant-bubble:opacity-100",
  ),
  user: cn(
    "sm:[@media(hover:hover)]:opacity-0",
    "sm:[@media(hover:hover)]:group-hover/user-bubble:opacity-100",
    "sm:[@media(hover:hover)]:group-focus-within/user-bubble:opacity-100",
  ),
} as const;

/**
 * The visible time of a message: the clock alone today, "yesterday 14:32"
 * the day before, and the short date with the clock further back. Days are
 * compared in the reader's display zone (the formatters carry it). Pure, so
 * the three tiers are pinned by a unit test.
 */
export function messageTimeText(
  iso: string,
  now: number,
  formatters: Pick<Formatters, "dateShortSmart" | "time">,
  t: Translate,
): string {
  const day = formatters.dateShortSmart(iso);
  const time = formatters.time(iso);
  if (day === formatters.dateShortSmart(new Date(now))) return time;
  if (day === formatters.dateShortSmart(new Date(now - DAY_MS))) {
    return t("insights.coach.answer.timeYesterday", { time });
  }
  return t("insights.coach.answer.timeEarlier", { date: day, time });
}

/**
 * What the details tooltip says about an answer: the model that wrote it and
 * the tokens it cost, one line each, in that order, each only when known. The
 * count is the server's (`done.usage` live, `tokensUsed` on reload),
 * formatted for the reader's locale. Empty when neither is known, and then
 * the row offers no details icon at all.
 */
export function answerInfoLines(
  tokens: number | null | undefined,
  model: string | null | undefined,
  locale: string,
  t: Translate,
): string[] {
  const lines: string[] = [];
  if (model) lines.push(t("insights.coach.answer.infoModel", { model }));
  if (tokens != null) {
    let count: string;
    try {
      count = new Intl.NumberFormat(locale).format(tokens);
    } catch {
      count = String(tokens);
    }
    lines.push(t("insights.coach.tokensUsed", { count }));
  }
  return lines;
}

function CopyMessageButton({
  content,
  strip,
}: {
  content: string;
  strip: boolean;
}) {
  const { t } = useTranslations();
  const supported = useClipboardSupported();
  const [copied, setCopied] = useState(false);
  const handle = useCallback(async () => {
    // Assistant prose is copied as the bubble shows it, without chart
    // tokens; user text is verbatim.
    const text = strip ? stripChartTokens(content) : content;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("insights.coach.copyMessageError"));
    }
  }, [content, strip, t]);
  // Absent where the Clipboard API is (plain-HTTP self-hosts) rather than
  // error-toasting on tap.
  if (!supported) return null;
  const label = t("insights.coach.copyMessage");
  return (
    <button
      type="button"
      data-slot="coach-copy-message"
      onClick={handle}
      aria-label={label}
      title={label}
      className={COACH_ICON_BUTTON}
    >
      {copied ? (
        <Check className="text-success size-4" aria-hidden="true" />
      ) : (
        <Copy className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}

/** Re-runs the question that produced this answer. */
function TryAgainButton({ onRegenerate }: { onRegenerate: () => void }) {
  const { t } = useTranslations();
  const label = t("insights.coach.regenerate");
  return (
    <button
      type="button"
      data-slot="coach-try-again"
      onClick={onRegenerate}
      aria-label={label}
      title={label}
      className={COACH_ICON_BUTTON}
    >
      <RotateCcw className="size-4" aria-hidden="true" />
    </button>
  );
}

/**
 * Whether the details tooltip is open after a click on its icon, given its
 * state when the pointer went down (`null`: no pointer went down, so Enter
 * or Space activated the button). A tap or a mouse click toggles from that
 * state, before the primitive's own pointer-down close ran. A keyboard
 * activation always opens: focus has already opened the tooltip, and a
 * toggle would close it on Enter. Escape is the keyboard's way out.
 */
export function answerInfoOpenAfterClick(
  openAtPointerDown: boolean | null,
): boolean {
  return openAtPointerDown === null ? true : !openAtPointerDown;
}

/**
 * The model and token count of an answer, behind an info icon. A tooltip,
 * opened the three ways a reader can reach it: hovering the icon, focusing
 * it from the keyboard, and tapping it on a touch screen, where there is no
 * hover. A second tap, a tap elsewhere or Escape closes it.
 *
 * The click is handled here because the tooltip primitive closes on every
 * click (`answerInfoOpenAfterClick` decides instead).
 */
function AnswerInfoButton({ lines }: { lines: string[] }) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const openAtPointerDown = useRef<boolean | null>(null);
  const label = t("insights.coach.answer.info");
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="coach-answer-info"
            aria-label={label}
            className={COACH_ICON_BUTTON}
            onPointerDown={() => {
              openAtPointerDown.current = open;
            }}
            onClick={(event) => {
              // Keep the primitive from closing it again on this click.
              event.preventDefault();
              setOpen(answerInfoOpenAfterClick(openAtPointerDown.current));
              openAtPointerDown.current = null;
            }}
          >
            <Info className="size-4" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          data-slot="coach-answer-info-content"
          className="flex flex-col gap-0.5 tabular-nums"
        >
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * When the message was written, as text. The visible run is short ("14:32");
 * the full date and time ride the `title` and the screen-reader text.
 */
function MessageTime({ iso }: { iso: string }) {
  const { t } = useTranslations();
  const formatters = useFormatters();
  // "Today" is fixed when the row mounts; a thread left open past midnight
  // keeps its labels until the next render from fresh data.
  const [now] = useState(Date.now);
  const full = formatters.dateTime(iso);
  return (
    <time
      dateTime={iso}
      title={full}
      data-slot="coach-message-time"
      className="text-muted-foreground shrink-0 px-1 text-xs whitespace-nowrap tabular-nums"
    >
      <span aria-hidden="true">{messageTimeText(iso, now, formatters, t)}</span>
      <span className="sr-only">
        {t("insights.coach.messageTimeLabel", { time: full })}
      </span>
    </time>
  );
}

/**
 * Stores the user's message in the self-context (Settings → AI) on one tap,
 * so it rides every future system prompt. The server picks the field from
 * the text itself. The icon confirms in place and a toast says where it
 * went; the button never unmounts, so keyboard focus stays on it.
 */
function RememberMessageButton({ content }: { content: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [settled, setSettled] = useState<"adopted" | "duplicate" | null>(null);

  const remember = useMutation({
    mutationFn: async () =>
      apiPost<{ adopted: boolean }>("/api/coach/about-me/adopt", {
        answer: content,
      }),
    onSuccess: (data) => {
      if (data.adopted) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.coachAboutMe(),
        });
      }
      setSettled(data.adopted ? "adopted" : "duplicate");
      // A new entry is a write (success); an existing one is an honest
      // non-event (neutral), the same mapping `toastWrittenOutcome` uses.
      // Called directly: importing the outcome module here regroups the
      // shared chunks and costs ~16 KB gz across the client bundle.
      (data.adopted ? toast.success : toast.info)(
        t(
          data.adopted
            ? "insights.coach.rememberMessage.done"
            : "insights.coach.rememberMessage.duplicate",
        ),
      );
    },
    onError: () => {
      toast.error(t("insights.coach.rememberMessage.failed"));
    },
  });

  const label = settled
    ? t("insights.coach.answer.rememberDone")
    : t("insights.coach.rememberMessage.action");
  const inert = settled !== null || remember.isPending;
  return (
    <button
      type="button"
      data-slot="coach-remember-message"
      data-state={settled ?? (remember.isPending ? "pending" : "idle")}
      onClick={() => {
        if (!inert) remember.mutate();
      }}
      // aria-disabled, not disabled: a disabled button drops keyboard focus.
      aria-disabled={inert || undefined}
      aria-busy={remember.isPending || undefined}
      aria-label={label}
      title={label}
      className={COACH_ICON_BUTTON}
    >
      {remember.isPending ? (
        <Loader2
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : settled ? (
        // Green only for the entry this tap wrote; "already there" stays
        // neutral.
        <BookmarkCheck
          className={cn("size-4", settled === "adopted" && "text-success")}
          aria-hidden="true"
        />
      ) : (
        <BookmarkPlus className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}

export interface AssistantMessageActionsProps {
  content: string;
  /** Read aloud and try again wait until the answer has settled. */
  streaming: boolean;
  createdAt?: string;
  onRegenerate?: () => void;
  tokens?: number | null;
  model?: string | null;
}

export function AssistantMessageActions({
  content,
  streaming,
  createdAt,
  onRegenerate,
  tokens,
  model,
}: AssistantMessageActionsProps) {
  const { t, locale } = useTranslations();
  const info = answerInfoLines(tokens, model, resolveIntlLocale(locale), t);
  return (
    <div
      data-slot="coach-answer-actions"
      className={cn(
        "flex w-full min-w-0 items-center gap-0.5 self-stretch",
        REVEAL.assistant,
        "transition-opacity duration-150 motion-reduce:transition-none",
      )}
    >
      <CopyMessageButton content={content} strip />
      {!streaming && <ReadAloudButton content={content} />}
      {!streaming && onRegenerate && (
        <TryAgainButton onRegenerate={onRegenerate} />
      )}
      {!streaming && info.length > 0 && <AnswerInfoButton lines={info} />}
      {createdAt && <MessageTime iso={createdAt} />}
    </div>
  );
}

export interface UserMessageActionsProps {
  content: string;
  /** Present once the message is persisted; an optimistic copy has none. */
  messageId?: string;
  createdAt?: string;
}

export function UserMessageActions({
  content,
  messageId,
  createdAt,
}: UserMessageActionsProps) {
  // Only a persisted message that fits the self-context field can be kept.
  const canRemember = !!messageId && content.length <= ABOUT_ME_FIELD_MAX_CHARS;
  return (
    <div
      data-slot="coach-user-actions"
      className={cn(
        "flex items-center justify-end gap-0.5",
        REVEAL.user,
        "transition-opacity duration-150 motion-reduce:transition-none",
      )}
    >
      <CopyMessageButton content={content} strip={false} />
      {canRemember && <RememberMessageButton content={content} />}
      {createdAt && <MessageTime iso={createdAt} />}
    </div>
  );
}
