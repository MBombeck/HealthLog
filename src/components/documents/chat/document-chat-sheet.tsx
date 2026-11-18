"use client";

/**
 * #1403 — asking about one document from inside a managed profile.
 *
 * The owner asks through the Coach drawer, which a shared record does not
 * mount (the Coach and its conversations stay the owner's). A guardian gets
 * the same conversation on the document's own endpoint,
 * `POST /api/documents/inbound/{id}/chat`: grounded in that document's text
 * only, under the profile's AI capability, consent and provider. The sheet
 * borrows the drawer's frame and the Coach's bubbles so the two read the
 * same; it opens a fresh conversation each time, as the drawer does.
 */
import { useRef, useState, type FormEvent } from "react";
import { FileText, Send } from "lucide-react";

import {
  ChatBubble,
  TypingDots,
} from "@/components/insights/coach-panel/chat-bubble";
import { errorCodeToI18nKey } from "@/components/insights/coach-panel/coach-error-key";
import { parseSseChunk } from "@/components/insights/coach-panel/use-coach";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

interface Turn {
  role: "user" | "assistant";
  content: string;
  errorCode?: string | null;
}

interface ChatFrame {
  type: string;
  token?: string;
  code?: string;
  conversationId?: string;
}

export function DocumentChatSheet({
  documentId,
  title,
  open,
  onOpenChange,
}: {
  documentId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useTranslations();
  const isPhoneViewport = useIsMobile("sm");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const conversationId = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  function handleOpenChange(next: boolean) {
    if (!next) {
      // A fresh conversation on the next open, as the drawer does.
      abort.current?.abort();
      conversationId.current = null;
      setTurns([]);
      setStreaming(null);
      setDraft("");
    }
    onOpenChange(next);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || streaming !== null) return;
    setDraft("");
    setTurns((prev) => [...prev, { role: "user", content: message }]);
    setStreaming("");

    const controller = new AbortController();
    abort.current = controller;
    let text = "";
    let errorCode: string | null = null;
    try {
      const response = await apiFetchRaw(
        `/api/documents/inbound/${encodeURIComponent(documentId)}/chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            message,
            locale,
            ...(conversationId.current
              ? { conversationId: conversationId.current }
              : {}),
          }),
          signal: controller.signal,
        },
      );
      const isStream = (response.headers.get("Content-Type") ?? "")
        .toLowerCase()
        .startsWith("text/event-stream");
      if (!response.body || !isStream) {
        let code = `coach.http.${response.status}`;
        try {
          const envelope = (await response.json()) as {
            meta?: { errorCode?: string };
          };
          code = envelope.meta?.errorCode ?? code;
        } catch {
          // Keep the status-shaped code.
        }
        errorCode = code;
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSseChunk(
            buffer,
            decoder.decode(value, { stream: true }),
          );
          buffer = parsed.rest;
          for (const raw of parsed.events) {
            const frame = raw as unknown as ChatFrame;
            if (frame.type === "token" && typeof frame.token === "string") {
              text += frame.token;
              setStreaming(text);
            } else if (frame.type === "done" && frame.conversationId) {
              conversationId.current = frame.conversationId;
            } else if (frame.type === "error") {
              errorCode = frame.code ?? "coach.stream";
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      errorCode = "coach.network";
    }
    setStreaming(null);
    setTurns((prev) => [
      ...prev,
      { role: "assistant", content: text, errorCode },
    ]);
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side={isPhoneViewport ? "bottom" : "right"}
        data-slot="document-chat-sheet"
        className={cn(
          "w-full p-0 sm:max-w-[720px]",
          isPhoneViewport
            ? "flex h-[90dvh] max-h-[90dvh] flex-col gap-0 rounded-t-2xl"
            : "flex h-[100dvh] flex-col gap-0",
        )}
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="min-w-0 truncate text-sm font-semibold">
            {t("documents.chat.title")}
          </SheetTitle>
          <SheetDescription className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <FileText className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {t("insights.coach.docScope.chattingAbout", { title })}
            </span>
          </SheetDescription>
        </SheetHeader>

        <div
          className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
          aria-live="polite"
        >
          {turns.map((turn, index) => (
            <ChatBubble
              key={index}
              role={turn.role}
              content={
                turn.errorCode
                  ? t(errorCodeToI18nKey(turn.errorCode))
                  : turn.content
              }
              errorCode={turn.errorCode ?? null}
            />
          ))}
          {streaming !== null ? (
            streaming === "" ? (
              <TypingDots label={t("insights.coach.thinking")} />
            ) : (
              <ChatBubble
                role="assistant"
                content={streaming}
                streaming
                inProgress
              />
            )
          ) : null}
        </div>

        <form
          onSubmit={send}
          className="flex items-end gap-2 border-t px-4 py-3"
          data-slot="document-chat-composer"
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("insights.coach.composerPlaceholder")}
            aria-label={t("insights.coach.composerPlaceholder")}
            rows={2}
            className="min-h-11 flex-1 resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            className="min-h-11 min-w-11"
            disabled={draft.trim() === "" || streaming !== null}
            aria-label={t("insights.coach.send")}
          >
            <Send className="size-4" aria-hidden />
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
