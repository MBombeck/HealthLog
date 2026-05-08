"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Save,
  Shield,
  Trash2,
  User,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/settings/password-input";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format";
import { locales, localeLabels, type Locale } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";
import { describePasskeyError } from "@/lib/passkey-errors";

interface PasskeyInfo {
  id: string;
  name: string;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  createdAt: string;
}

export function AccountSection() {
  const { t, locale, setLocale } = useTranslations();
  const { user, isLoading, isAuthenticated, refetch } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveMsgType, setSaveMsgType] = useState<"success" | "error" | null>(
    null,
  );

  // Password change dialog state.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [passwordMsgType, setPasswordMsgType] = useState<
    "success" | "error" | null
  >(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);

  // Passkey registration state.
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeyMsg, setPasskeyMsg] = useState<string | null>(null);
  const [passkeyMsgType, setPasskeyMsgType] = useState<
    "success" | "error" | null
  >(null);

  // Auth gate — push back to login if the user is unauthenticated. Effect
  // intentionally only navigates (never sets state in a way that re-runs the
  // effect), so the lint rule is satisfied without a disable.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  // Hydrate the form draft once the auth payload arrives. Using the
  // React-recommended "store-the-prop-id alongside the state" pattern so the
  // sync-from-server happens during render (not in a setState-in-effect),
  // satisfying the strict `react-hooks/set-state-in-effect` rule.
  const [seededUserId, setSeededUserId] = useState<string | null>(null);
  if (user && user.id !== seededUserId) {
    setSeededUserId(user.id);
    setEmail(user.email ?? "");
    setHeightCm(user.heightCm?.toString() ?? "");
    setDateOfBirth(
      user.dateOfBirth
        ? new Date(user.dateOfBirth).toISOString().slice(0, 10)
        : "",
    );
    setGender(user.gender ?? "");
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    setSaveMsgType(null);

    const res = await fetch("/api/auth/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email.trim() || null,
        heightCm: heightCm ? parseFloat(heightCm) : null,
        dateOfBirth: dateOfBirth || null,
        gender: gender || null,
      }),
    });

    if (res.ok) {
      setSaveMsg(t("settings.profileSaved"));
      setSaveMsgType("success");
      await refetch();
    } else {
      const json = await res.json();
      setSaveMsg(json.error || t("settings.savingError"));
      setSaveMsgType("error");
    }
    setSaving(false);
  }

  async function handleAddPasskey() {
    setPasskeyLoading(true);
    setPasskeyMsg(null);
    setPasskeyMsgType(null);

    try {
      const optRes = await fetch("/api/auth/passkey/register-options", {
        method: "POST",
      });

      if (!optRes.ok) {
        setPasskeyMsg(t("settings.passkeyOptionsError"));
        setPasskeyMsgType("error");
        setPasskeyLoading(false);
        return;
      }

      const optJson = await optRes.json();
      const { options, challengeId } = optJson.data;

      const { startRegistration } = await import("@simplewebauthn/browser");
      const credential = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, credential }),
      });

      if (verifyRes.ok) {
        setPasskeyMsg(t("settings.passkeyAdded"));
        setPasskeyMsgType("success");
      } else {
        const verifyJson = await verifyRes.json();
        setPasskeyMsg(
          verifyJson.error || t("settings.passkeyRegistrationFailed"),
        );
        setPasskeyMsgType("error");
      }
    } catch (err) {
      const { key, params } = describePasskeyError(err);
      setPasskeyMsg(t(key, params));
      setPasskeyMsgType("error");
    } finally {
      setPasskeyLoading(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordSaving(true);
    setPasswordMsg(null);
    setPasswordMsgType(null);

    if (newPassword !== confirmPassword) {
      setPasswordMsg(t("settings.passwordMismatch"));
      setPasswordMsgType("error");
      setPasswordSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/auth/password", {
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
        setPasswordMsg(json.error || t("settings.savingError"));
        setPasswordMsgType("error");
        return;
      }

      setPasswordMsg(t("settings.passwordUpdated"));
      setPasswordMsgType("success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setPasswordMsg(t("common.networkError"));
      setPasswordMsgType("error");
    } finally {
      setPasswordSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <section
      aria-labelledby="settings-section-account-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-account-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.account.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.account.description")}
        </p>
      </header>

      {/* Profile card */}
      <div className="bg-card border-border rounded-xl border p-6">
        <div className="mb-4 flex items-center gap-2">
          <User className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.profile")}</h2>
        </div>
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="username">{t("settings.username")}</Label>
              <Input id="username" value={user.username} disabled />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">{t("auth.email")}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("auth.emailPlaceholder")}
                maxLength={320}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="gender">{t("settings.gender")}</Label>
              <select
                id="gender"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                <option value="">{t("settings.genderNone")}</option>
                <option value="MALE">{t("settings.genderMale")}</option>
                <option value="FEMALE">{t("settings.genderFemale")}</option>
              </select>
              <p className="text-muted-foreground text-xs">
                {t("settings.genderHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="height">{t("settings.height")}</Label>
              <Input
                id="height"
                type="number"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                placeholder="175"
                min={50}
                max={300}
                step={0.1}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="dob">{t("settings.dateOfBirth")}</Label>
              <Input
                id="dob"
                type="date"
                value={dateOfBirth}
                onChange={(e) => setDateOfBirth(e.target.value)}
                max={new Date().toISOString().slice(0, 10)}
              />
              <p className="text-muted-foreground text-xs">
                {t("settings.dateOfBirthHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="language-select">{t("settings.language")}</Label>
              <select
                id="language-select"
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="border-input bg-background text-foreground ring-offset-background focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                {locales.map((loc) => (
                  <option key={loc} value={loc}>
                    {localeLabels[loc as Locale]}
                  </option>
                ))}
              </select>
              <p className="text-muted-foreground text-xs">
                {t("settings.languageDescription")}
              </p>
            </div>
          </div>

          {saveMsg && (
            <p
              role="alert"
              className={`text-sm ${
                saveMsgType === "success"
                  ? "text-dracula-green"
                  : "text-destructive"
              }`}
            >
              {saveMsg}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {t("common.save")}
            </Button>
          </div>
        </form>
      </div>

      {/* Passkeys card */}
      <div className="bg-card border-border rounded-xl border p-6">
        <div className="mb-4 flex items-center gap-2">
          <Shield className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.passkeys")}</h2>
        </div>
        <PasskeyListSection isAuthenticated={isAuthenticated} />
        <div className="mt-4 flex justify-end">
          <Button
            variant="outline"
            onClick={handleAddPasskey}
            disabled={passkeyLoading}
          >
            {passkeyLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="mr-2 h-4 w-4" />
            )}
            {t("settings.addPasskey")}
          </Button>
        </div>
        {passkeyMsg && (
          <p
            role="alert"
            className={`mt-2 text-right text-sm ${
              passkeyMsgType === "success"
                ? "text-dracula-green"
                : "text-destructive"
            }`}
          >
            {passkeyMsg}
          </p>
        )}
      </div>

      {/* Password card */}
      <div className="bg-card border-border rounded-xl border p-6">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Shield className="text-primary h-5 w-5" />
            <h2 className="text-lg font-semibold">
              {t("settings.passwordReset")}
            </h2>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setPasswordDialogOpen(true)}
          >
            {t("settings.changePassword")}
          </Button>
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("settings.changePasswordDescription")}
        </p>
      </div>

      <Dialog
        open={passwordDialogOpen}
        onOpenChange={(open) => {
          setPasswordDialogOpen(open);
          if (!open) {
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            setPasswordMsg(null);
            setPasswordMsgType(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("settings.passwordReset")}</DialogTitle>
            <DialogDescription>
              {t("settings.changePasswordDescription")}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleChangePassword} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="current-password">
                  {t("settings.currentPassword")}
                </Label>
                <PasswordInput
                  id="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-password">
                  {t("settings.newPassword")}
                </Label>
                <PasswordInput
                  id="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">
                  {t("settings.confirmNewPassword")}
                </Label>
                <PasswordInput
                  id="confirm-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
            </div>

            {passwordMsg && (
              <p
                role="alert"
                className={`text-sm ${
                  passwordMsgType === "success"
                    ? "text-dracula-green"
                    : "text-destructive"
                }`}
              >
                {passwordMsg}
              </p>
            )}

            <Button type="submit" variant="outline" disabled={passwordSaving}>
              {passwordSaving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {t("settings.changePassword")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PasskeyListSection({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  const { data: passkeys } = useQuery({
    queryKey: ["passkeys"],
    queryFn: async () => {
      const res = await fetch("/api/auth/passkeys");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as PasskeyInfo[];
    },
    enabled: isAuthenticated,
  });

  const deletePasskey = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/auth/passkeys/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("common.error"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["passkeys"] });
      setDeleteMsg(null);
    },
    onError: (err: Error) => {
      setDeleteMsg(err.message);
    },
  });

  const DEVICE_TYPE_LABELS: Record<string, string> = {
    singleDevice: t("settings.singleDevice"),
    multiDevice: t("settings.multiDevice"),
  };

  if (!passkeys || passkeys.length === 0) {
    return (
      <div>
        <h3 className="text-sm font-medium">{t("settings.passkeys")}</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("settings.noPasskeys")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium">
        {t("settings.registeredPasskeys")}
      </h3>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.passkeysDescription")}
      </p>
      <div className="border-border mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="bg-muted/40 text-muted-foreground border-b text-xs">
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.passkeyName")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.passkeyDevice")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.passkeyBackup")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.passkeyCreated")}
              </th>
              <th className="px-3 py-2 text-right font-medium">
                {t("settings.passkeyActions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {passkeys.map((pk, idx) => (
              <tr key={pk.id} className={idx % 2 === 0 ? "bg-muted/20" : ""}>
                <td className="px-3 py-2 font-medium">{pk.name}</td>
                <td className="text-muted-foreground px-3 py-2 text-xs">
                  {DEVICE_TYPE_LABELS[pk.credentialDeviceType] ??
                    pk.credentialDeviceType}
                </td>
                <td className="px-3 py-2 text-xs">
                  <Badge
                    variant={pk.credentialBackedUp ? "secondary" : "outline"}
                    className="text-[11px]"
                  >
                    {pk.credentialBackedUp
                      ? t("settings.backedUp")
                      : t("common.no")}
                  </Badge>
                </td>
                <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                  {formatDate(pk.createdAt)}
                </td>
                <td className="px-3 py-2 text-right">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive h-8 w-8"
                        disabled={deletePasskey.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("settings.deletePasskey")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("settings.deletePasskeyDescription")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t("common.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => deletePasskey.mutate(pk.id)}
                        >
                          {t("common.delete")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleteMsg && (
        <div
          role="alert"
          className="text-destructive mt-2 flex items-center gap-2 text-sm"
        >
          <AlertTriangle className="h-4 w-4" />
          {deleteMsg}
        </div>
      )}
    </div>
  );
}
