"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Activity, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import {
  SettingsToggle,
  getApiErrorMessage,
  useAdminSettings,
  useUpdateSettings,
} from "./_shared";

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
      const res = await fetch("/api/admin/monitoring/umami-test", {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      const json = (await res.json()) as { data?: { message?: string } };
      return json.data?.message ?? t("admin.monitoringTestSuccess");
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
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("admin.umamiTitle")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {configured && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("admin.configured")}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("admin.umamiDescription")}
      </p>

      <div className="mt-4 space-y-3">
        <SettingsToggle
          label={t("admin.umamiEnabled")}
          icon={Activity}
          checked={settings?.umamiEnabled ?? false}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ umamiEnabled: checked })
          }
          disabled={updateSettings.isPending}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="admin-umami-script-url" className="text-xs">
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
              disabled={updateSettings.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-umami-website-id" className="text-xs">
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
              disabled={updateSettings.isPending}
            />
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => testUmami.mutate()}
          disabled={testUmami.isPending || updateSettings.isPending}
        >
          {testUmami.isPending && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("common.test")}
        </Button>
        <Button
          size="sm"
          onClick={saveUmamiSettings}
          disabled={updateSettings.isPending}
        >
          {updateSettings.isPending && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
