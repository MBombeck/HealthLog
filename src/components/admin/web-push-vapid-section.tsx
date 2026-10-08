"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellRing, KeyRound, Loader2 } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import {
  ConfiguredBadge,
  PasswordInput,
  useAdminSettings,
  useUpdateSettings,
} from "./_shared";

export function WebPushVapidSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
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
  const [generating, setGenerating] = useState(false);
  // Overwrite guard: the first generate returns 409 when keys already exist;
  // we surface the project's AlertDialog (not a native window.confirm) before
  // retrying with force, since regenerating invalidates every live Web-Push
  // subscription.
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);

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

  async function generateVapidKeys(force: boolean) {
    setGenerating(true);
    try {
      const res = await apiFetchRaw(
        "/api/admin/settings/web-push-vapid/generate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(force ? { force: true } : {}),
        },
      );

      if (res.status === 409) {
        // Overwrite guard — existing keys would be replaced. Surface the
        // in-app confirm dialog (regenerating invalidates current
        // subscriptions); the dialog action retries with force.
        setOverwriteConfirmOpen(true);
        return;
      }

      if (!res.ok) {
        toast.error(t("admin.webPushVapidGenerateFailed"));
        return;
      }

      const json = (await res.json()) as {
        data: { webPushVapidPublicKey: string; webPushVapidSubject: string };
      };
      // The private key was minted and encrypted server-side; only the
      // public key + subject come back. Populate the visible fields and
      // leave the private-key input empty (it stays "configured").
      setWebPushVapidPublicKeyDraft(json.data.webPushVapidPublicKey);
      setWebPushVapidSubjectDraft(json.data.webPushVapidSubject);
      setWebPushVapidPrivateKeyDraft("");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.adminSettings(),
      });
      toast.success(t("admin.webPushVapidGenerated"));
    } catch {
      toast.error(t("admin.webPushVapidGenerateFailed"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={BellRing}
        title={t("admin.webPushVapidTitle")}
        description={t("admin.webPushVapidDescription")}
        status={configured ? <ConfiguredBadge /> : null}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="admin-web-push-public-key">
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
            data-bwignore="true"
            disabled={updateSettings.isPending}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="admin-web-push-private-key">
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
            data-bwignore="true"
            disabled={updateSettings.isPending}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="admin-web-push-subject">
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
            data-bwignore="true"
            disabled={updateSettings.isPending}
          />
        </div>
      </div>

      <SettingsCardActions>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void generateVapidKeys(false)}
          disabled={generating || updateSettings.isPending}
        >
          {generating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <KeyRound className="h-3.5 w-3.5" />
          )}
          {generating
            ? t("admin.webPushVapidGenerating")
            : t("admin.webPushVapidGenerate")}
        </Button>
        <Button
          size="sm"
          onClick={saveWebPushVapidSettings}
          disabled={updateSettings.isPending}
        >
          {updateSettings.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("common.save")}
        </Button>
      </SettingsCardActions>

      <AlertDialog
        open={overwriteConfirmOpen}
        onOpenChange={setOverwriteConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin.webPushVapidGenerateConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.webPushVapidGenerateConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void generateVapidKeys(true)}
            >
              {t("admin.webPushVapidRegenerate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  );
}
