"use client";

/**
 * #159 — the free-text allergies / intolerances line, mounted directly under
 * the structured `AllergyManager` in the SAME Anamnese card.
 *
 * The structured list is the record; this line is its labelled free-text
 * SUPPLEMENT (context the structured rows cannot carry — "reacts within
 * minutes", "family suspects a cross-allergy"). The label + the one-sentence
 * hint say exactly that, so the two inputs never read as duplicates. It used
 * to live in the account-settings "About me" panel; the placement moved here
 * so both allergy inputs sit in one place.
 *
 * Data path is unchanged: the line is part of the self-context payload
 * (`GET`/`PUT /api/coach/about-me`), read and written through the same
 * `queryKeys.coachAboutMe()` query- and mutation-key the rest of the app
 * uses. The PUT sends only this field (plus the base token), so the note /
 * conditions / focus stay untouched by contract. Clearing the line is done in
 * the field itself — a deliberate act on the thing being emptied.
 *
 * Plain text only — the value renders exclusively through the input; no
 * markdown anywhere.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { withBaseToken, isConflict } from "@/lib/api/optimistic-token";

const FALLBACK_FIELD_MAX_CHARS = 500;

interface AboutMeData {
  aboutMe: string | null;
  conditions: string | null;
  allergies: string | null;
  coachFocus: string | null;
  updatedAt: string | null;
  fieldMaxChars: number;
}

const FIELD_CLASSES =
  "border-input bg-background placeholder:text-muted-foreground focus-visible:border-input-focus w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none";

export function AllergyFreeTextNote() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.coachAboutMe(),
    queryFn: () => apiGet<AboutMeData>("/api/coach/about-me"),
  });

  const savedLine = query.data?.allergies ?? "";
  const fieldMaxChars = query.data?.fieldMaxChars ?? FALLBACK_FIELD_MAX_CHARS;
  const value = draft ?? savedLine;
  const dirty = value !== savedLine;

  const save = useMutation({
    mutationKey: queryKeys.coachAboutMe(),
    // Send only the allergies line — omitted fields are preserved server-side
    // by the PUT contract. v1.32.21 (R5a) — echo the base token so a
    // concurrent self-context write 409s instead of silently losing.
    mutationFn: async (input: { allergies: string }) => {
      return apiPut<AboutMeData>(
        "/api/coach/about-me",
        withBaseToken(input, query.data?.updatedAt ?? undefined),
      );
    },
    onSuccess: () => {
      toast.success(t("records.allergies.freeText.savedToast"));
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachAboutMeQuestions(),
      });
    },
    onError: (err) => {
      if (isConflict(err)) {
        queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
        toast.message(t("common.conflictReloaded"));
        return;
      }
      toast.error(t("records.allergies.freeText.saveError"));
    },
  });

  const disabled = query.isLoading || save.isPending;

  return (
    <div
      className="border-border space-y-1.5 border-t pt-4"
      data-slot="allergy-free-text-note"
    >
      <Label htmlFor="records-allergy-free-text">
        {t("records.allergies.freeText.label")}
      </Label>
      {/* One sentence naming the difference: the structured rows above are
          the record; this line is free-text context supplementing them. */}
      <p className="text-muted-foreground text-xs">
        {t("records.allergies.freeText.hint")}
      </p>
      <textarea
        id="records-allergy-free-text"
        data-testid="records-allergy-free-text"
        className={cn(FIELD_CLASSES, "min-h-16 resize-y")}
        rows={2}
        value={value}
        maxLength={fieldMaxChars}
        placeholder={t("settings.ai.aboutMe.allergiesPlaceholder")}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
      />
      {query.isError ? (
        <QueryErrorRow
          message={t("settings.ai.aboutMe.loadError")}
          onRetry={() => query.refetch()}
        />
      ) : (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-testid="records-allergy-free-text-save"
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate({ allergies: value })}
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
      )}
    </div>
  );
}
