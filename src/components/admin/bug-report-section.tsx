"use client";

import { useState } from "react";
import { Bug, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import { PasswordInput, useAdminSettings, useUpdateSettings } from "./_shared";

export function BugReportSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const [bugReportRepoDraft, setBugReportRepoDraft] = useState<string | null>(
    null,
  );
  const [bugReportTokenDraft, setBugReportTokenDraft] = useState("");

  const bugReportRepoValue =
    bugReportRepoDraft ?? settings?.bugReportRepo ?? "";
  const configured = settings?.bugReportConfigured ?? false;

  function saveBugReportSettings() {
    const payload: Record<string, unknown> = {
      bugReportRepo: bugReportRepoValue,
    };
    if (bugReportTokenDraft.trim().length > 0) {
      payload.bugReportToken = bugReportTokenDraft.trim();
    }

    updateSettings.mutate(payload, {
      onSuccess: () => {
        setBugReportRepoDraft(null);
        setBugReportTokenDraft("");
      },
    });
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bug className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">
            {t("admin.bugReportGithub")}
          </h2>
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
        {t("admin.bugReportGithubDescription")}
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="admin-bugreport-repo" className="text-xs">
            {t("admin.bugReportRepo")}
          </Label>
          <Input
            id="admin-bugreport-repo"
            value={bugReportRepoValue}
            onChange={(event) => setBugReportRepoDraft(event.target.value)}
            placeholder={t("admin.bugReportRepoPlaceholder")}
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            disabled={updateSettings.isPending}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="admin-bugreport-token" className="text-xs">
            {t("admin.bugReportToken")}
          </Label>
          <PasswordInput
            id="admin-bugreport-token"
            value={bugReportTokenDraft}
            onChange={(event) => setBugReportTokenDraft(event.target.value)}
            placeholder={t("admin.bugReportTokenPlaceholder")}
            disabled={updateSettings.isPending}
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button
          size="sm"
          onClick={saveBugReportSettings}
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
