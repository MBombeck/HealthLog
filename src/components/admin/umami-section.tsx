"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Activity, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import {
  SettingsToggle,
  useAdminSettings,
  useUpdateSettings,
  ConfiguredBadge,
} from "./_shared";
import { apiPost } from "@/lib/api/api-fetch";

export function UmamiSection() {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const [umamiScriptUrlDraft, setUmamiScriptUrlDraft] = useState<string | null>(
    null,
  );
  const [umamiWebsiteIdDraft, setUmamiWebsiteIdDraft] = useState<string | null>(
    null,
  );

  const umamiScriptUrlValue =
    umamiScriptUrlDraft ?? settings?.umamiScriptUrl ?? "";
  const umamiWebsiteIdValue =
    umamiWebsiteIdDraft ?? settings?.umamiWebsiteId ?? "";

  const configured = Boolean(
    settings?.umamiScriptUrl && settings?.umamiWebsiteId,
  );

  const testUmami = useMutation({
    mutationFn: async () => {
      const data = await apiPost<{ message?: string } | undefined>(
        "/api/admin/monitoring/umami-test",
      );
      return data?.message ?? t("admin.monitoringTestSuccess");
    },
    onSuccess: (message) => {
      toast.success(message);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.monitoringTestFailed"),
      );
    },
  });

  function saveUmamiSettings() {
    updateSettings.mutate(
      {
        umamiScriptUrl: umamiScriptUrlValue,
        umamiWebsiteId: umamiWebsiteIdValue,
      },
      {
        onSuccess: () => {
          setUmamiScriptUrlDraft(null);
          setUmamiWebsiteIdDraft(null);
        },
      },
    );
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Activity}
        title={t("admin.umamiTitle")}
        description={t("admin.umamiDescription")}
        status={configured ? <ConfiguredBadge /> : null}
      />

      <div className="space-y-3">
        <SettingsToggle
          label={t("admin.umamiEnabled")}
          checked={settings?.umamiEnabled ?? false}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ umamiEnabled: checked })
          }
          disabled={updateSettings.isPending}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="admin-umami-script-url">
              {t("admin.umamiScriptUrl")}
            </Label>
            <Input
              id="admin-umami-script-url"
              name="admin-umami-script-url"
              value={umamiScriptUrlValue}
              onChange={(event) => setUmamiScriptUrlDraft(event.target.value)}
              placeholder={t("admin.umamiScriptUrlPlaceholder")}
              autoComplete="new-password"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              disabled={updateSettings.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-umami-website-id">
              {t("admin.umamiWebsiteId")}
            </Label>
            <Input
              id="admin-umami-website-id"
              name="admin-umami-website-id"
              value={umamiWebsiteIdValue}
              onChange={(event) => setUmamiWebsiteIdDraft(event.target.value)}
              placeholder={t("admin.umamiWebsiteIdPlaceholder")}
              autoComplete="new-password"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              disabled={updateSettings.isPending}
            />
          </div>
        </div>
      </div>

      <SettingsCardActions>
        <Button
          size="sm"
          variant="outline"
          onClick={() => testUmami.mutate()}
          disabled={testUmami.isPending || updateSettings.isPending}
        >
          {testUmami.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("common.test")}
        </Button>
        <Button
          size="sm"
          onClick={saveUmamiSettings}
          disabled={updateSettings.isPending}
        >
          {updateSettings.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("common.save")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
