"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
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

export function GlitchtipSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const [glitchtipDsnDraft, setGlitchtipDsnDraft] = useState<string | null>(
    null,
  );
  const [glitchtipEnvironmentDraft, setGlitchtipEnvironmentDraft] = useState<
    string | null
  >(null);

  const glitchtipDsnValue = glitchtipDsnDraft ?? settings?.glitchtipDsn ?? "";
  const glitchtipEnvironmentValue =
    glitchtipEnvironmentDraft ?? settings?.glitchtipEnvironment ?? "production";

  const configured = Boolean(settings?.glitchtipDsn);

  const testGlitchtip = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/monitoring/glitchtip-test", {
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

  function saveGlitchtipSettings() {
    updateSettings.mutate(
      {
        glitchtipDsn: glitchtipDsnValue,
        glitchtipEnvironment: glitchtipEnvironmentValue,
      },
      {
        onSuccess: () => {
          setGlitchtipDsnDraft(null);
          setGlitchtipEnvironmentDraft(null);
        },
      },
    );
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("admin.glitchtipTitle")}</h2>
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
        {t("admin.glitchtipDescription")}
      </p>

      <div className="mt-4 space-y-3">
        <SettingsToggle
          label="GlitchTip"
          description={t("admin.glitchtipEnabled")}
          icon={AlertTriangle}
          checked={settings?.glitchtipEnabled ?? false}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ glitchtipEnabled: checked })
          }
          disabled={updateSettings.isPending}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="admin-glitchtip-dsn" className="text-xs">
              {t("admin.glitchtipDsn")}
            </Label>
            <Input
              id="admin-glitchtip-dsn"
              name="admin-glitchtip-dsn"
              value={glitchtipDsnValue}
              onChange={(event) => setGlitchtipDsnDraft(event.target.value)}
              placeholder={t("admin.glitchtipDsnPlaceholder")}
              autoComplete="new-password"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              disabled={updateSettings.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-glitchtip-environment" className="text-xs">
              {t("admin.glitchtipEnvironment")}
            </Label>
            <Input
              id="admin-glitchtip-environment"
              name="admin-glitchtip-environment"
              value={glitchtipEnvironmentValue}
              onChange={(event) =>
                setGlitchtipEnvironmentDraft(event.target.value)
              }
              placeholder={t("admin.glitchtipEnvironmentPlaceholder")}
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
          onClick={() => testGlitchtip.mutate()}
          disabled={testGlitchtip.isPending || updateSettings.isPending}
        >
          {testGlitchtip.isPending && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          )}
          {t("common.test")}
        </Button>
        <Button
          size="sm"
          onClick={saveGlitchtipSettings}
          disabled={updateSettings.isPending}
        >
          {updateSettings.isPending && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          )}
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
