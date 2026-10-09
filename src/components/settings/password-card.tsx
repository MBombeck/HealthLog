"use client";

import { useState } from "react";
import { Loader2, Save, Shield } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  statusText,
  type StatusMessage,
} from "@/components/settings/account-section/account-section-utils";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";

/**
 * Change-password card.
 *
 * It used to sit at the bottom of Settings → Account, under the profile form
 * and the identity fields. Changing a password is not a profile edit — it is
 * the same decision as enrolling a second factor or adding a passkey, and
 * those live in Settings → Security. The card moved to sit with them so
 * "how I get into this account" reads as one place.
 *
 * The status hint stores the i18n KEY, not the translated string, so a locale
 * switch re-renders it in the new language — the settings-wide convention
 * `statusText` exists for.
 */
export function PasswordCard() {
  const { t } = useTranslations();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<StatusMessage | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setMsgType(null);

    if (newPassword !== confirmPassword) {
      setMsg({ key: "settings.passwordMismatch" });
      setMsgType("error");
      setSaving(false);
      return;
    }

    try {
      const res = await apiFetchRaw("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      });
      const json = await res.json();

      if (!res.ok) {
        setMsg(
          json.error ? { text: json.error } : { key: "settings.savingError" },
        );
        setMsgType("error");
        return;
      }

      setMsg({ key: "settings.passwordUpdated" });
      setMsgType("success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setMsg({ key: "common.networkError" });
      setMsgType("error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* The action is this card's only one, so it sits in the card's action
          row like every other primary. It stays full-width under `sm` — the
          German "Passwort ändern" is long enough that a right-hugging button
          used to break through the card's right border on a narrow phone. */}
      <SettingsCard data-slot="settings-password-card">
        <SettingsCardHeader
          anchor="password"
          icon={Shield}
          title={t("settings.passwordTitle")}
          description={t("settings.changePasswordDescription")}
        />
        <SettingsCardActions>
          <Button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="min-h-11 w-full sm:min-h-9 sm:w-auto"
          >
            {t("settings.changePassword")}
          </Button>
        </SettingsCardActions>
      </SettingsCard>

      <ResponsiveSheet
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            setMsg(null);
            setMsgType(null);
          }
        }}
        title={t("settings.passwordTitle")}
        description={t("settings.changePasswordDescription")}
        className="sm:max-w-xl"
      >
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="current-password">
                {t("settings.currentPassword")}
              </Label>
              <PasswordInput
                id="current-password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">{t("settings.newPassword")}</Label>
              <PasswordInput
                id="new-password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">
                {t("settings.confirmNewPassword")}
              </Label>
              <PasswordInput
                id="confirm-password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          </div>

          {msg && (
            <p
              role="alert"
              className={`text-sm ${
                msgType === "success" ? "text-success" : "text-destructive"
              }`}
            >
              {statusText(msg, t)}
            </p>
          )}

          <Button
            type="submit"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t("settings.changePassword")}
          </Button>
        </form>
      </ResponsiveSheet>
    </>
  );
}
