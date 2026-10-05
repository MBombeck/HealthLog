"use client";

import { useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COACH_CONVERSATION_TITLE_MAX } from "@/lib/ai/coach/types";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import { useRenameCoachConversation } from "./use-coach";

export type ConversationRenameKeyAction = "save" | "cancel";

export function getConversationRenameKeyAction(
  key: string,
): ConversationRenameKeyAction | null {
  if (key === "Enter") return "save";
  if (key === "Escape") return "cancel";
  return null;
}

export interface ConversationRenameProps {
  id: string;
  title: string;
  /**
   * Controlled mode, for a surface that opens the editor from somewhere else
   * (the conversations panel's row menu). When set, the component renders no
   * trigger of its own: it shows the form while `editing` is true and reports
   * the end of an edit (saved or cancelled) through `onEditingChange`.
   */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}

export function ConversationRename({
  id,
  title,
  editing: controlledEditing,
  onEditingChange,
}: ConversationRenameProps) {
  const { t } = useTranslations();
  const rename = useRenameCoachConversation();
  const controlled = controlledEditing !== undefined;
  const [localEditing, setLocalEditing] = useState(false);
  const editing = controlled ? controlledEditing : localEditing;
  const [draft, setDraft] = useState(title);
  // A controlled editor opens from outside, so it seeds its draft from the
  // current title each time it opens (render-phase, no effect).
  const [seededOpen, setSeededOpen] = useState(false);
  if (controlled && editing !== seededOpen) {
    setSeededOpen(editing);
    if (editing) setDraft(title);
  }
  function setEditing(next: boolean) {
    if (controlled) onEditingChange?.(next);
    else setLocalEditing(next);
  }
  const submittingRef = useRef(false);

  function cancel() {
    if (rename.isPending) return;
    setDraft(title);
    setEditing(false);
  }

  async function save() {
    const nextTitle = draft.trim();
    if (
      submittingRef.current ||
      rename.isPending ||
      nextTitle.length === 0 ||
      nextTitle.length > COACH_CONVERSATION_TITLE_MAX
    ) {
      return;
    }
    if (nextTitle === title) {
      setDraft(title);
      setEditing(false);
      return;
    }

    submittingRef.current = true;
    try {
      await rename.mutateAsync({ id, title: nextTitle });
      setEditing(false);
    } catch {
      // The shared mutation restores every cache and surfaces the localized
      // failure. Keep the user's draft in the input so retrying loses nothing.
    } finally {
      submittingRef.current = false;
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const action = getConversationRenameKeyAction(event.key);
    if (!action) return;
    event.preventDefault();
    // Escape belongs to the editor while it is open: the panel and the sheet
    // around it must not close on the same key press.
    event.stopPropagation();
    if (action === "cancel") cancel();
    else void save();
  }

  if (!editing) {
    if (controlled) return null;
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        aria-label={t("insights.coach.rename.action")}
        data-slot="coach-conversation-rename"
        className="shrink-0"
      >
        <Pencil className="size-4" aria-hidden="true" />
      </Button>
    );
  }

  const invalid =
    draft.trim().length === 0 ||
    draft.trim().length > COACH_CONVERSATION_TITLE_MAX;

  return (
    <form
      onSubmit={handleSubmit}
      data-slot="coach-conversation-rename-form"
      className={cn(
        "bg-background absolute inset-y-1 left-1 z-10 flex min-w-0 items-center gap-1",
        controlled ? "right-1" : "right-16",
      )}
    >
      <Input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={rename.isPending}
        maxLength={COACH_CONVERSATION_TITLE_MAX}
        aria-label={t("insights.coach.rename.input")}
        data-slot="coach-conversation-rename-input"
        className="h-10 min-w-0 flex-1"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        disabled={rename.isPending || invalid}
        aria-label={t("insights.coach.rename.save")}
        data-slot="coach-conversation-rename-save"
        className="size-10 shrink-0"
      >
        {rename.isPending ? (
          <Loader2
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <Check className="size-4" aria-hidden="true" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={cancel}
        disabled={rename.isPending}
        aria-label={t("insights.coach.rename.cancel")}
        data-slot="coach-conversation-rename-cancel"
        className="size-10 shrink-0"
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
    </form>
  );
}
