"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import { SettingsToggle } from "./_shared";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  DEFAULT_REASONING_MAX_EFFORT,
  REASONING_ADMIN_KEYS,
  REASONING_LEVEL_LABEL_KEYS,
  REASONING_MAX_EFFORTS,
  type ReasoningMaxEffort,
} from "@/lib/ai/reasoning/levels";

/**
 * Operator-side panel for the five assistant switches, and (v1.41) the two
 * reasoning controls: whether models may think before they answer at all,
 * and the highest depth a person may choose. Background jobs follow the
 * same switch; there is no separate one.
 *
 * The five switches: The master stops
 * every AI feature; four sub-switches each stop one cost or egress profile:
 * the Coach, the daily briefing, status notes (per-reading notes, workout
 * notes, reaction lines) and reading documents (the vault, lab scans,
 * medication extraction). A switch stops AI work and hides AI text; data,
 * charts and scores keep loading either way.
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
    assistantDocumentAiEnabled: boolean;
  };
  resolved: {
    enabled: boolean;
    coach: boolean;
    briefing: boolean;
    insightStatus: boolean;
    documentAi: boolean;
  };
  /** v1.41 — the operator's reasoning controls; absent before v1.41. */
  reasoning?: { enabled: boolean; maxEffort: ReasoningMaxEffort };
}

/** What the route accepts: any of the switches, and the reasoning pair. */
type AssistantFlagsPatch = Partial<AssistantFlagsResponse["raw"]> & {
  aiReasoningEnabled?: boolean;
  aiReasoningMaxEffort?: ReasoningMaxEffort;
};

function useAssistantFlags() {
  return useQuery({
    queryKey: queryKeys.adminAssistantFlags(),
    queryFn: async () => {
      return apiGet<AssistantFlagsResponse>(
        "/api/admin/settings/assistant-flags",
      );
    },
  });
}

function useUpdateAssistantFlags() {
  const client = useQueryClient();
  const { t } = useTranslations();
  return useMutation({
    mutationFn: async (
      patch: AssistantFlagsPatch,
    ): Promise<AssistantFlagsResponse> => {
      return apiPut<AssistantFlagsResponse>(
        "/api/admin/settings/assistant-flags",
        patch,
      );
    },
    onSuccess: (data) => {
      client.setQueryData(queryKeys.adminAssistantFlags(), data);
      // Every record's resolved AI capabilities ride the account payload,
      // which is the only thing the web reads them from; bust it so the
      // operator sees the change within the session.
      void invalidateKeys(client, aiInputDependentKeys);
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
  const reasoningOn = data?.reasoning?.enabled ?? true;

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Sparkles}
        title={t("admin.assistant.title")}
        description={t("admin.assistant.description")}
      />
      <div className="space-y-4">
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
            label={t("admin.assistant.documentAi.title")}
            description={t("admin.assistant.documentAi.description")}
            checked={raw?.assistantDocumentAiEnabled ?? true}
            onCheckedChange={(checked) =>
              mutation.mutate({ assistantDocumentAiEnabled: checked })
            }
            disabled={disabledSubs}
          />
        </div>

        {/* v1.41 — reasoning: allowed at all, and how deep at most. */}
        <div
          data-slot="admin-assistant-reasoning"
          className="border-border space-y-4 border-t pt-4"
        >
          <SettingsToggle
            label={t(REASONING_ADMIN_KEYS.enabled)}
            description={t(REASONING_ADMIN_KEYS.description)}
            checked={reasoningOn}
            onCheckedChange={(checked) =>
              mutation.mutate({ aiReasoningEnabled: checked })
            }
            disabled={disabledSubs}
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <Label
              htmlFor="admin-reasoning-max"
              noColon
              // On the toggles' left edge: the primitive's `pl-1` would
              // inset this one label beside the switch rows above it.
              className="pl-0 text-sm font-medium"
            >
              {t(REASONING_ADMIN_KEYS.max)}
            </Label>
            <NativeSelect
              id="admin-reasoning-max"
              data-slot="admin-reasoning-max"
              className="sm:w-48"
              value={data?.reasoning?.maxEffort ?? DEFAULT_REASONING_MAX_EFFORT}
              disabled={disabledSubs || !reasoningOn}
              onChange={(e) =>
                mutation.mutate({
                  aiReasoningMaxEffort: e.target.value as ReasoningMaxEffort,
                })
              }
            >
              {REASONING_MAX_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {t(REASONING_LEVEL_LABEL_KEYS[effort])}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}
