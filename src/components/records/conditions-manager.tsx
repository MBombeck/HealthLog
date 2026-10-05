"use client";

/**
 * v1.25.12 — pre-existing / chronic conditions editor, at home in the Anamnese
 * (medical-history) section.
 *
 * The chronic-conditions note and the explicit "what should the Coach watch"
 * focus are foundational medical history, so they are edited here next to
 * allergies + family history — one coherent medical-history home. They used to
 * be edited under Settings → Profile → "About me"; the editing moved here so the
 * conditions the Coach watches sit with the rest of the medical record.
 *
 * Data path is unchanged: both fields are part of the self-context payload
 * (`GET`/`PUT /api/coach/about-me`) and are read/written through the same
 * `queryKeys.coachAboutMe()` query- and mutation-key the rest of the app uses,
 * so every consumer (the Coach above all) keeps reading the same store. The PUT
 * sends only the two fields this editor owns, so unreadable or concurrently
 * updated profile text and allergies stay untouched.
 *
 * Plain text only — values render exclusively through inputs and React text
 * children; no markdown renderer (XSS posture, see contributor notes).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { apiGet, apiPut } from "@/lib/api/api-fetch";

const FALLBACK_FIELD_MAX_CHARS = 500;

interface AboutMeData {
  aboutMe: string | null;
  conditions: string | null;
  allergies: string | null;
  coachFocus: string | null;
  fieldMaxChars: number;
}

const FIELD_CLASSES =
  "border-input bg-background placeholder:text-muted-foreground focus-visible:border-input-focus w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none";

export function ConditionsManager() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<{
    conditions: string | null;
    coachFocus: string | null;
  }>({ conditions: null, coachFocus: null });

  const query = useQuery({
    queryKey: queryKeys.coachAboutMe(),
    queryFn: () => apiGet<AboutMeData>("/api/coach/about-me"),
  });

  const saved = {
    conditions: query.data?.conditions ?? "",
    coachFocus: query.data?.coachFocus ?? "",
  };
  const fieldMaxChars = query.data?.fieldMaxChars ?? FALLBACK_FIELD_MAX_CHARS;

  const value = {
    conditions: drafts.conditions ?? saved.conditions,
    coachFocus: drafts.coachFocus ?? saved.coachFocus,
  };
  const dirty =
    value.conditions !== saved.conditions ||
    value.coachFocus !== saved.coachFocus;

  const save = useMutation({
    mutationKey: queryKeys.coachAboutMe(),
    mutationFn: async (input: { conditions: string; coachFocus: string }) =>
      apiPut<AboutMeData>("/api/coach/about-me", {
        conditions: input.conditions,
        coachFocus: input.coachFocus,
      }),
    onSuccess: () => {
      toast.success(t("records.conditions.savedToast"));
      setDrafts({ conditions: null, coachFocus: null });
      queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachAboutMeQuestions(),
      });
    },
    onError: () => {
      toast.error(t("records.conditions.saveError"));
    },
  });

  const disabled = query.isLoading || save.isPending;

  function field(
    key: "conditions" | "coachFocus",
    label: string,
    placeholder: string,
  ) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`records-conditions-${key}`}>{label}</Label>
        <textarea
          id={`records-conditions-${key}`}
          data-testid={`records-conditions-${key}`}
          className={cn(FIELD_CLASSES, "min-h-16 resize-y")}
          rows={2}
          value={value[key]}
          maxLength={fieldMaxChars}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-slot="conditions-manager">
      {query.isError ? (
        <QueryErrorCard
          title={t("records.conditions.loadError")}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          {field(
            "conditions",
            t("records.conditions.conditionsLabel"),
            t("settings.ai.aboutMe.conditionsPlaceholder"),
          )}
          {field(
            "coachFocus",
            t("records.conditions.focusLabel"),
            t("settings.ai.aboutMe.focusPlaceholder"),
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-testid="records-conditions-save"
              disabled={disabled || !dirty}
              onClick={() => save.mutate(value)}
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
        </>
      )}
    </div>
  );
}
