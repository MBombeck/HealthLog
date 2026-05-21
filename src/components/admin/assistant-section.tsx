"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { SettingsToggle, getApiErrorMessage } from "./_shared";

/**
 * v1.4.31 — operator-side panel for the six assistant feature
 * flags. The master toggle gates the whole assistant; five
 * sub-toggles carve specific surfaces (Coach, Daily Briefing,
 * per-metric status cards, correlation narration, Health-Score
 * delta explainer).
 *
 * UX:
 *   - Master toggle at the top. When off, the sub-toggles are
 *     visually greyed out (kept rendered so the operator can see
 *     which sub-flags are individually flipped before they unmute
 *     the master) but cannot be flipped via the disabled `<Switch>`.
 *   - Optimistic flip + server confirm via `useMutation`; failure
 *     surfaces a toast and reverts the in-flight toggle by
 *     re-invalidating the read query.
 */

interface AssistantFlagsResponse {
  raw: {
    assistantEnabled: boolean;
    assistantCoachEnabled: boolean;
    assistantBriefingEnabled: boolean;
    assistantInsightStatusEnabled: boolean;
    assistantCorrelationsEnabled: boolean;
    assistantHealthScoreExplainerEnabled: boolean;
  };
  resolved: {
    enabled: boolean;
    coach: boolean;
    briefing: boolean;
    insightStatus: boolean;
    correlations: boolean;
    healthScoreExplainer: boolean;
  };
}

function useAssistantFlags() {
  return useQuery({
    queryKey: queryKeys.adminAssistantFlags(),
    queryFn: async () => {
      const res = await fetch("/api/admin/settings/assistant-flags");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as AssistantFlagsResponse;
    },
  });
}

function useUpdateAssistantFlags() {
  const client = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (
      patch: Partial<AssistantFlagsResponse["raw"]>,
    ): Promise<AssistantFlagsResponse> => {
      const res = await fetch("/api/admin/settings/assistant-flags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      return (await res.json()).data as AssistantFlagsResponse;
    },
    onSuccess: (data) => {
      client.setQueryData(
        queryKeys.adminAssistantFlags(),
        data,
      );
      // Bust the runtime `/api/feature-flags` cache so the operator
      // sees the toggled surface react within the same session.
      client.invalidateQueries({ queryKey: queryKeys.featureFlags() });
      toast.success(t("common.saved"));
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.settingsSaveError"),
      );
      client.invalidateQueries({
        queryKey: queryKeys.adminAssistantFlags(),
      });
    },
  });
}

export function AssistantSection() {
  const { t } = useTranslations();
  const { data } = useAssistantFlags();
  const mutation = useUpdateAssistantFlags();

  const raw = data?.raw;
  const masterOn = raw?.assistantEnabled ?? true;
  const disabledSubs = !masterOn || mutation.isPending;

  return (
    <div className="bg-card border-border space-y-6 rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <Sparkles className="text-primary h-5 w-5" />
        <div className="text-lg font-semibold">{t("admin.assistant.title")}</div>
      </div>
      <p className="text-muted-foreground text-sm">
        {t("admin.assistant.description")}
      </p>

      <SettingsToggle
        label={t("admin.assistant.master.title")}
        description={t("admin.assistant.master.description")}
        checked={raw?.assistantEnabled ?? true}
        onCheckedChange={(checked) =>
          mutation.mutate({ assistantEnabled: checked })
        }
        disabled={mutation.isPending}
      />

      <div className="border-border space-y-4 border-t pt-4">
        <SettingsToggle
          label={t("admin.assistant.coach.title")}
          description={t("admin.assistant.coach.description")}
          checked={raw?.assistantCoachEnabled ?? true}
          onCheckedChange={(checked) =>
            mutation.mutate({ assistantCoachEnabled: checked })
          }
          disabled={disabledSubs}
        />
        <SettingsToggle
          label={t("admin.assistant.briefing.title")}
          description={t("admin.assistant.briefing.description")}
          checked={raw?.assistantBriefingEnabled ?? true}
          onCheckedChange={(checked) =>
            mutation.mutate({ assistantBriefingEnabled: checked })
          }
          disabled={disabledSubs}
        />
        <SettingsToggle
          label={t("admin.assistant.insightStatus.title")}
          description={t("admin.assistant.insightStatus.description")}
          checked={raw?.assistantInsightStatusEnabled ?? true}
          onCheckedChange={(checked) =>
            mutation.mutate({ assistantInsightStatusEnabled: checked })
          }
          disabled={disabledSubs}
        />
        <SettingsToggle
          label={t("admin.assistant.correlations.title")}
          description={t("admin.assistant.correlations.description")}
          checked={raw?.assistantCorrelationsEnabled ?? true}
          onCheckedChange={(checked) =>
            mutation.mutate({ assistantCorrelationsEnabled: checked })
          }
          disabled={disabledSubs}
        />
        <SettingsToggle
          label={t("admin.assistant.healthScoreExplainer.title")}
          description={t("admin.assistant.healthScoreExplainer.description")}
          checked={raw?.assistantHealthScoreExplainerEnabled ?? true}
          onCheckedChange={(checked) =>
            mutation.mutate({
              assistantHealthScoreExplainerEnabled: checked,
            })
          }
          disabled={disabledSubs}
        />
      </div>
    </div>
  );
}
