"use client";

/**
 * #159 — the "About me" free-text note, at home in the Anamnese
 * (medical-history) section.
 *
 * v1.15.20 introduced the note under Settings → AI, v1.18.1 moved it to the
 * account profile, v1.25.12 moved the chronic conditions + Coach focus out of
 * it into the Anamnese. This completes the move: the note itself is personal
 * medical context the Coach and the daily briefing read, so it lives with
 * conditions, allergies and family history as one coherent medical history.
 * The card header (title/description) is rendered by `anamnesis-section.tsx`,
 * matching the neighbouring managers.
 *
 * Data path is unchanged: the note is part of the self-context payload
 * (`GET`/`PUT /api/coach/about-me`), read and written through the same
 * `queryKeys.coachAboutMe()` query- and mutation-key the rest of the app
 * uses. The PUT sends only the field this editor owns (plus the base token),
 * so conditions / focus / allergies stay untouched by contract.
 *
 * The "Clear" control writes `aboutMe: ""` and NOTHING else — the allergies
 * field is omitted from the payload so the stored allergy line survives (the
 * v1.32-era scoped-clear lesson; see `about-me-clear-scope.test.tsx`).
 *
 * Plain text only — every value renders exclusively through inputs and React
 * text children; no markdown anywhere.
 */
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircleQuestion, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { SettingsInfoTile } from "@/components/settings/_info-tile";
import { Label } from "@/components/ui/label";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { withBaseToken, isConflict } from "@/lib/api/optimistic-token";

const FALLBACK_MAX_CHARS = 4000;

interface AboutMeData {
  aboutMe: string | null;
  conditions: string | null;
  allergies: string | null;
  coachFocus: string | null;
  pendingQuestions: string[];
  updatedAt: string | null;
  maxChars: number;
  fieldMaxChars: number;
}

const FIELD_CLASSES =
  "border-input bg-background placeholder:text-muted-foreground focus-visible:border-input-focus w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none";

export function AboutMeNoteManager() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const coach = useAiCapability("coach");
  const [draft, setDraft] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.coachAboutMe(),
    queryFn: () => apiGet<AboutMeData>("/api/coach/about-me"),
  });

  const savedNote = query.data?.aboutMe ?? "";
  const maxChars = query.data?.maxChars ?? FALLBACK_MAX_CHARS;
  const pendingQuestions = query.data?.pendingQuestions ?? [];

  const value = draft ?? savedNote;
  const dirty = value !== savedNote;
  // The clear control only ever touches the note, so it only appears when
  // there is a note to clear.
  const hasNote = savedNote.length > 0;

  const save = useMutation({
    mutationKey: queryKeys.coachAboutMe(),
    // Send only the note. `conditions` / `coachFocus` / `allergies` are
    // omitted so the server preserves them (they are edited in their own
    // cards). v1.32.21 (R5a) — echo the base token this edit was based on so
    // a concurrent write to the same self-context 409s instead of silently
    // overwriting the newer state.
    mutationFn: async (input: { aboutMe: string }) => {
      return apiPut<AboutMeData>(
        "/api/coach/about-me",
        withBaseToken(input, query.data?.updatedAt ?? undefined),
      );
    },
    onSuccess: (next) => {
      const cleared = !next.aboutMe;
      toast.success(
        cleared
          ? t("settings.ai.aboutMe.clearedToast")
          : t("settings.ai.aboutMe.savedToast"),
      );
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachAboutMeQuestions(),
      });
    },
    onError: (err) => {
      // v1.32.21 (R5a) — a 409 means the stored self-context advanced since
      // this edit was based. Refetch so the token advances, KEEP the draft so
      // the user can re-save, nudge gently.
      if (isConflict(err)) {
        queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
        toast.message(t("common.conflictReloaded"));
        return;
      }
      toast.error(t("settings.ai.aboutMe.saveError"));
    },
  });

  const disabled = query.isLoading || save.isPending;

  return (
    <div className="space-y-4" data-slot="about-me-note-manager">
      <div className="space-y-1.5">
        <Label htmlFor="settings-about-me-freetext">
          {t("settings.ai.aboutMe.freeTextLabel")}
        </Label>
        <textarea
          id="settings-about-me-freetext"
          data-testid="settings-about-me-textarea"
          className={cn(FIELD_CLASSES, "min-h-36 resize-y")}
          value={value}
          maxLength={maxChars}
          placeholder={t("settings.ai.aboutMe.placeholder")}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          data-testid="settings-about-me-count"
          className="text-muted-foreground text-xs tabular-nums"
        >
          {t("settings.ai.aboutMe.charCount", {
            used: value.length,
            max: maxChars,
          })}
        </p>
        <div className="flex items-center gap-2">
          {hasNote && (
            <ConfirmButton
              slot="settings-about-me-clear"
              label={t("settings.ai.aboutMe.clear")}
              icon={<Trash2 className="size-4" aria-hidden />}
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              title={t("settings.ai.aboutMe.clearTitle")}
              body={t("settings.ai.aboutMe.clearBody")}
              confirmLabel={t("settings.ai.aboutMe.clearConfirm")}
              pending={save.isPending}
              onConfirm={() => save.mutate({ aboutMe: "" })}
            />
          )}
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-testid="settings-about-me-save"
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate({ aboutMe: value })}
          >
            {save.isPending && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            )}
            {t("settings.ai.aboutMe.save")}
          </Button>
        </div>
      </div>

      {pendingQuestions.length > 0 && (
        <SettingsInfoTile
          icon={MessageCircleQuestion}
          tone="primary"
          data-testid="settings-about-me-questions"
          title={t("settings.ai.aboutMe.questionsTitle")}
        >
          <ul className="list-disc space-y-1 pl-6">
            {pendingQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          {/* Only while the Coach can open; without it the link would
              bounce back to Insights. The questions stay readable. */}
          {coach.available ? (
            <p className="mt-3 text-xs">
              <Link
                href="/coach"
                className="text-primary underline-offset-4 hover:underline"
              >
                {t("settings.ai.aboutMe.questionsOpenCoach")}
              </Link>
            </p>
          ) : null}
        </SettingsInfoTile>
      )}

      {query.isError && (
        <QueryErrorRow
          message={t("settings.ai.aboutMe.loadError")}
          onRetry={() => query.refetch()}
        />
      )}

      <p className="text-muted-foreground border-border border-t pt-3 text-xs">
        {t("settings.ai.aboutMe.hint")} {t("settings.ai.aboutMe.profileHint")}
      </p>
    </div>
  );
}
