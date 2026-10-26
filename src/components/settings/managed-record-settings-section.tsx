"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings } from "lucide-react";

import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useAuth } from "@/hooks/use-auth";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import {
  assertRecordSettingsResponseForRecord,
  safeParseManagedRecordSettingsPatch,
  type ManagedRecordSettingsFamily,
} from "@/lib/record-settings";

import { SettingsCardHeader } from "./_card-header";
import { CoachSettingsForm } from "./managed-record/coach-form";
import type { SettingsFormProps } from "./managed-record/form-kit";
import { InsightsSettingsForm } from "./managed-record/insights-form";
import { ModulesSettingsForm } from "./managed-record/modules-form";
import { NotificationsSettingsForm } from "./managed-record/notifications-form";
import { ProfileSettingsForm } from "./managed-record/profile-form";
import { ThresholdsSettingsForm } from "./managed-record/thresholds-form";
import { SettingsCard } from "./settings-card";

interface ManagedRecordSettingsResponse {
  recordId: string;
  family: ManagedRecordSettingsFamily;
  settings: Record<string, unknown>;
}

type ManagedSettingsFamily = Exclude<
  ManagedRecordSettingsFamily,
  "integrations"
>;

export function ManagedRecordSettingsForm({
  family,
  ...props
}: SettingsFormProps & { family: ManagedSettingsFamily }) {
  switch (family) {
    case "profile":
      return <ProfileSettingsForm {...props} />;
    case "modules":
      return <ModulesSettingsForm {...props} />;
    case "notifications":
      return <NotificationsSettingsForm {...props} />;
    case "thresholds":
      return <ThresholdsSettingsForm {...props} />;
    case "coach":
      return <CoachSettingsForm {...props} />;
    case "insights":
      return <InsightsSettingsForm {...props} />;
  }
}

/**
 * Managed settings use typed target-record controls only. The actor's
 * Settings components never mount here, so their actor-scoped queries and
 * mutations cannot fire while a Guardian administers a profile.
 */
export function ManagedRecordSettingsSection({
  family,
}: {
  family: ManagedSettingsFamily;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const recordId = user?.accountAccess?.active?.accountId ?? null;
  const [validationFailed, setValidationFailed] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.recordSettingsFamily(recordId ?? "", family),
    enabled: recordId !== null,
    queryFn: async () => {
      const response = await apiGet<ManagedRecordSettingsResponse>(
        `/api/record-settings/${family}`,
      );
      assertRecordSettingsResponseForRecord(response, recordId);
      if (response.family !== family) {
        throw new Error(
          "Managed record settings response did not match its key",
        );
      }
      return response;
    },
  });
  const save = useMutation({
    mutationFn: async (patch: unknown) => {
      const response = await apiPatch<ManagedRecordSettingsResponse>(
        `/api/record-settings/${family}`,
        patch,
      );
      assertRecordSettingsResponseForRecord(response, recordId);
      if (response.family !== family) {
        throw new Error(
          "Managed record settings response did not match its key",
        );
      }
      return response;
    },
    onSuccess: (response) => {
      if (recordId === null) return;
      queryClient.setQueryData(
        queryKeys.recordSettingsFamily(recordId, family),
        response,
      );
      // The record's module map, Hide Coach and profile (gender gates the
      // cycle module) are inputs of the `/me` answer for this record, its AI
      // capabilities included.
      void invalidateKeys(queryClient, aiInputDependentKeys);
    },
  });

  if (query.isError) {
    return (
      <QueryErrorCard
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <SettingsCard
      aria-busy={query.isLoading}
      data-record-id={recordId ?? undefined}
      data-record-settings-family={family}
    >
      <SettingsCardHeader
        icon={Settings}
        title={t(`settings.sharedRecord.managedSettings.${family}.title`)}
      />
      {query.data ? (
        <ManagedRecordSettingsForm
          disabled={save.isPending}
          family={family}
          // §12 — the form renders this ABOVE its action row; nothing follows
          // the action.
          error={
            validationFailed
              ? t("settings.sharedRecord.managedSettings.validationError")
              : save.isError
                ? t("settings.sharedRecord.managedSettings.saveError")
                : undefined
          }
          onSave={(patch) => {
            const parsed = safeParseManagedRecordSettingsPatch(family, patch);
            if (!parsed.success) {
              setValidationFailed(true);
              return;
            }
            setValidationFailed(false);
            save.mutate(parsed.data);
          }}
          saveLabel={t("common.save")}
          settings={query.data.settings}
        />
      ) : null}
    </SettingsCard>
  );
}
