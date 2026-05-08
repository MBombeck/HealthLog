"use client";

import { useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import { PasswordInput, useAdminSettings, useUpdateSettings } from "./_shared";

export function WebPushVapidSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const [webPushVapidPublicKeyDraft, setWebPushVapidPublicKeyDraft] = useState<
    string | null
  >(null);
  const [webPushVapidPrivateKeyDraft, setWebPushVapidPrivateKeyDraft] =
    useState("");
  const [webPushVapidSubjectDraft, setWebPushVapidSubjectDraft] = useState<
    string | null
  >(null);

  const webPushVapidPublicKeyValue =
    webPushVapidPublicKeyDraft ?? settings?.webPushVapidPublicKey ?? "";
  const webPushVapidSubjectValue =
    webPushVapidSubjectDraft ?? settings?.webPushVapidSubject ?? "";

  const configured = settings?.webPushVapidConfigured ?? false;

  function saveWebPushVapidSettings() {
    const payload: Record<string, unknown> = {
      webPushVapidPublicKey: webPushVapidPublicKeyValue,
      webPushVapidSubject: webPushVapidSubjectValue,
    };
    if (webPushVapidPrivateKeyDraft.trim().length > 0) {
      payload.webPushVapidPrivateKey = webPushVapidPrivateKeyDraft.trim();
    }

    updateSettings.mutate(payload, {
      onSuccess: () => {
        setWebPushVapidPublicKeyDraft(null);
        setWebPushVapidPrivateKeyDraft("");
        setWebPushVapidSubjectDraft(null);
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
          <BellRing className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">
            {t("admin.webPushVapidTitle")}
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
        {t("admin.webPushVapidDescription")}
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="admin-web-push-public-key" className="text-xs">
            {t("admin.webPushVapidPublicKey")}
          </Label>
          <Input
            id="admin-web-push-public-key"
            name="admin-web-push-public-key"
            value={webPushVapidPublicKeyValue}
            onChange={(event) =>
              setWebPushVapidPublicKeyDraft(event.target.value)
            }
            placeholder={t("admin.webPushVapidPublicKeyPlaceholder")}
            autoComplete="new-password"
            spellCheck={false}
            data-lpignore="true"
            data-1p-ignore="true"
            disabled={updateSettings.isPending}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="admin-web-push-private-key" className="text-xs">
            {t("admin.webPushVapidPrivateKey")}
          </Label>
          <PasswordInput
            id="admin-web-push-private-key"
            name="admin-web-push-private-key"
            value={webPushVapidPrivateKeyDraft}
            onChange={(event) =>
              setWebPushVapidPrivateKeyDraft(event.target.value)
            }
            placeholder={t("admin.webPushVapidPrivateKeyPlaceholder")}
            autoComplete="new-password"
            spellCheck={false}
            data-lpignore="true"
            data-1p-ignore="true"
            disabled={updateSettings.isPending}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="admin-web-push-subject" className="text-xs">
            {t("admin.webPushVapidSubject")}
          </Label>
          <Input
            id="admin-web-push-subject"
            name="admin-web-push-subject"
            value={webPushVapidSubjectValue}
            onChange={(event) =>
              setWebPushVapidSubjectDraft(event.target.value)
            }
            placeholder={t("admin.webPushVapidSubjectPlaceholder")}
            autoComplete="new-password"
            spellCheck={false}
            data-lpignore="true"
            data-1p-ignore="true"
            disabled={updateSettings.isPending}
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button
          size="sm"
          onClick={saveWebPushVapidSettings}
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
