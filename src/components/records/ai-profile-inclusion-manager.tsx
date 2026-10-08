"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Switch } from "@/components/ui/switch";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
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
    },
    onError: (error) => {
      if (isConflict(error)) {
        queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
      }
      toast.error(t("records.aiInclusion.saveError"));
    },
  });

  if (query.isError) {
    return (
      <QueryErrorCard
        title={t("records.aiInclusion.loadError")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const disabled = query.isLoading || save.isPending;

  return (
    <div className="space-y-4" data-slot="ai-profile-inclusion-manager">
      <div className="divide-border divide-y">
        {HEALTH_PROFILE_AI_SECTIONS.map((section) => {
          const checked = value.includes(section);
          return (
            <div
              key={section}
              className="flex min-h-11 items-center justify-between gap-4 py-2"
            >
              <label
                htmlFor={`ai-profile-section-${section}`}
                className="text-sm"
              >
                {t(SECTION_LABEL_KEY[section])}
              </label>
              <Switch
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
                aria-label={t(SECTION_LABEL_KEY[section])}
              />
            </div>
          );
        })}
      </div>
      <SettingsCardActions>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
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
