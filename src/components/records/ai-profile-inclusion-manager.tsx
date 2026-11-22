"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SwitchRow } from "@/components/ui/switch-row";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { useAboutMeSaveTimeoutMs } from "@/hooks/use-ai-capability";
import {
  isConflict,
  readUpdatedAtToken,
  withBaseToken,
} from "@/lib/api/optimistic-token";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  HEALTH_PROFILE_AI_SECTIONS,
  type HealthProfileAiSection,
} from "@/lib/validations/health-profile-facts";

interface AboutMeData {
  aboutMe: string | null;
  conditions: string | null;
  allergies: string | null;
  coachFocus: string | null;
  aiIncludedSections: HealthProfileAiSection[];
  updatedAt: string | null;
}

const SECTION_LABEL_KEY: Record<HealthProfileAiSection, string> = {
  ABOUT_ME: "records.aiInclusion.sectionAboutMe",
  CONDITIONS: "records.aiInclusion.sectionConditions",
  ALLERGIES: "records.aiInclusion.sectionAllergies",
  COACH_FOCUS: "records.aiInclusion.sectionCoachFocus",
  FAMILY_HISTORY: "records.aiInclusion.sectionFamilyHistory",
  SMOKING_STATUS: "records.aiInclusion.sectionSmoking",
  ALCOHOL_PATTERN: "records.aiInclusion.sectionAlcohol",
  SHIFT_SCHEDULE: "records.aiInclusion.sectionShiftSchedule",
};

/**
 * v1.43 (#614) — smoking, alcohol and shift work are switched beside their
 * answers in the life-circumstances card; listing them here as well would put
 * two switches for one setting on one page. They still travel in the PUT
 * below with their saved value, so this card never changes them.
 */
const LIFE_CARD_SECTIONS: ReadonlySet<HealthProfileAiSection> = new Set([
  "SMOKING_STATUS",
  "ALCOHOL_PATTERN",
  "SHIFT_SCHEDULE",
]);

export function AiProfileInclusionManager() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<HealthProfileAiSection[] | null>(null);
  const query = useQuery({
    queryKey: queryKeys.coachAboutMe(),
    queryFn: () => apiGet<AboutMeData>("/api/coach/about-me"),
  });

  const saved = query.data?.aiIncludedSections ?? [];
  const value = draft ?? saved;
  const dirty =
    draft !== null &&
    HEALTH_PROFILE_AI_SECTIONS.some(
      (section) => draft.includes(section) !== saved.includes(section),
    );

  const saveTimeoutMs = useAboutMeSaveTimeoutMs();
  const save = useMutation({
    mutationKey: queryKeys.coachAboutMe(),
    mutationFn: (sections: HealthProfileAiSection[]) =>
      apiPut<AboutMeData>(
        "/api/coach/about-me",
        withBaseToken(
          {
            aiIncludedSections: sections,
          },
          readUpdatedAtToken(queryClient, queryKeys.coachAboutMe()) ??
            undefined,
        ),
        { signal: AbortSignal.timeout(saveTimeoutMs) },
      ),
    onSuccess: () => {
      setDraft(null);
      toastWrittenOutcome("success", t("records.aiInclusion.savedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachAboutMeQuestions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.insightsAdvisor(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.lifeCircumstances(),
      });
    },
    onError: (error) => {
      if (isConflict(error)) {
        queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
      }
      showErrorToast(t("records.aiInclusion.saveError"), { cause: error });
    },
  });

  if (query.isError) {
    return (
      <QueryErrorCard
        error={query.error}
        title={t("records.aiInclusion.loadError")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const disabled = query.isLoading || save.isPending;

  return (
    <div className="space-y-4" data-slot="ai-profile-inclusion-manager">
      <div className="divide-border divide-y">
        {HEALTH_PROFILE_AI_SECTIONS.filter(
          (section) => !LIFE_CARD_SECTIONS.has(section),
        ).map((section) => {
          const checked = value.includes(section);
          return (
            <SwitchRow
              key={section}
              className="min-h-11 py-2"
              label={t(SECTION_LABEL_KEY[section])}
              id={`ai-profile-section-${section}`}
              checked={checked}
              disabled={disabled}
              onCheckedChange={(next) => {
                const current = draft ?? saved;
                setDraft(
                  next
                    ? [...current, section]
                    : current.filter((item) => item !== section),
                );
              }}
            />
          );
        })}
      </div>
      <SettingsCardActions>
        <Button
          type="button"
          size="sm"
          disabled={disabled || !dirty}
          onClick={() => save.mutate(value)}
        >
          {save.isPending && (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {t("records.aiInclusion.save")}
        </Button>
      </SettingsCardActions>
    </div>
  );
}
