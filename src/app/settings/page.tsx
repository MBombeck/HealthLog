"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  KeyRound,
  Bell,
  BellRing,
  Loader2,
  MessageCircle,
  Save,
  Send,
  Shield,
  Key,
  Trash2,
  Link2,
  Unlink,
  RefreshCw,
  Download,
  Sparkles,
  AlertTriangle,
  ChevronDown,
  Eye,
  EyeOff,
  User,
  Smile,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { locales, localeLabels, type Locale } from "@/lib/i18n/config";
import { invalidateKeys, measurementDependentKeys } from "@/lib/query-keys";
import { describePasskeyError } from "@/lib/passkey-errors";
import { ThresholdsSection } from "@/components/settings/thresholds-section";
import { DashboardLayoutSection } from "@/components/settings/dashboard-layout-section";

function PasswordInput(props: React.ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? "text" : "password"} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((v) => !v)}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

interface GlobalServiceAvailability {
  telegramGlobal: boolean;
  ntfyGlobal: boolean;
  webPushGlobal: boolean;
  apiGlobal: boolean;
  moodLogGlobal: boolean;
}

export default function SettingsPage() {
  const { user, isLoading, isAuthenticated, refetch } = useAuth();
  const { t, locale, setLocale } = useTranslations();
  const queryClient = useQueryClient();
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
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [passwordMsgType, setPasswordMsgType] = useState<
    "success" | "error" | null
  >(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeyMsg, setPasskeyMsg] = useState<string | null>(null);
  const [passkeyMsgType, setPasskeyMsgType] = useState<
    "success" | "error" | null
  >(null);

  const { data: globalServices } = useQuery({
    queryKey: ["settings", "global-services"],
    queryFn: async () => {
      const res = await fetch("/api/settings/global-services");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as GlobalServiceAvailability;
    },
    enabled: isAuthenticated,
  });

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (user) {
      setEmail(user.email ?? "");
      setHeightCm(user.heightCm?.toString() ?? "");
      setDateOfBirth(
        user.dateOfBirth
          ? new Date(user.dateOfBirth).toISOString().slice(0, 10)
          : "",
      );
      setGender(user.gender ?? "");
    }
  }, [user]);

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
        queryClient.invalidateQueries({ queryKey: ["passkeys"] });
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
  const serviceAvailability: GlobalServiceAvailability = {
    telegramGlobal: globalServices?.telegramGlobal ?? true,
    ntfyGlobal: globalServices?.ntfyGlobal ?? true,
    webPushGlobal: globalServices?.webPushGlobal ?? true,
    apiGlobal: globalServices?.apiGlobal ?? true,
    moodLogGlobal: globalServices?.moodLogGlobal ?? true,
  };
  const hasNotificationServices =
    serviceAvailability.telegramGlobal ||
    serviceAvailability.ntfyGlobal ||
    serviceAvailability.webPushGlobal;

  return (
    <div className="space-y-6 overflow-x-hidden">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("settings.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.subtitle")}
        </p>
      </div>

      {user.role === "ADMIN" && (
        <div className="bg-card border-border mb-6 rounded-xl border p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Shield className="text-primary h-5 w-5" />
                <h2 className="text-lg font-semibold">
                  {t("settings.adminAreaTitle")}
                </h2>
              </div>
              <p className="text-muted-foreground text-sm">
                {t("settings.adminAreaDescription")}
              </p>
            </div>
            <Button asChild variant="outline">
              <Link href="/admin">
                <Shield className="mr-2 h-4 w-4" />
                {t("settings.openAdminConsole")}
              </Link>
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-8">
        <section id="section-allgemein" className="scroll-mt-28 space-y-3">
          <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
            {t("settings.categoryGeneral")}
          </h2>

          {/* Profile Section */}
          <div
            id="profil"
            className="bg-card border-border rounded-xl border p-6"
          >
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
                  <Label htmlFor="language-select">
                    {t("settings.language")}
                  </Label>
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
        </section>

        <section id="section-sicherheit" className="scroll-mt-28 space-y-3">
          <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
            {t("settings.security")}
          </h2>

          <div
            id="passkeys"
            className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
          >
            <div className="mb-4 flex items-center gap-2">
              <Shield className="text-primary h-5 w-5" />
              <h2 className="text-lg font-semibold">
                {t("settings.passkeys")}
              </h2>
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
              {passkeyMsg && (
                <p
                  role="alert"
                  className={`mt-2 text-sm ${
                    passkeyMsgType === "success"
                      ? "text-dracula-green"
                      : "text-destructive"
                  }`}
                >
                  {passkeyMsg}
                </p>
              )}
            </div>
          </div>

          <div
            id="passwort"
            className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
          >
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

                <Button
                  type="submit"
                  variant="outline"
                  disabled={passwordSaving}
                >
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

        {hasNotificationServices && (
          <section
            id="section-benachrichtigungen"
            className="scroll-mt-28 space-y-3"
          >
            <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
              {t("settings.categoryNotifications")}
            </h2>
            {serviceAvailability.telegramGlobal && (
              <TelegramSection
                id="telegram"
                isAuthenticated={isAuthenticated}
              />
            )}
            {serviceAvailability.ntfyGlobal && (
              <NtfySection id="ntfy" isAuthenticated={isAuthenticated} />
            )}
            {serviceAvailability.webPushGlobal && (
              <WebPushSection id="web-push" />
            )}
          </section>
        )}

        <section
          id="section-personalization"
          className="scroll-mt-28 space-y-3"
        >
          <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
            {t("settings.categoryPersonalization")}
          </h2>
          <DashboardLayoutSection id="dashboard-layout" />
          <ThresholdsSection id="thresholds" />
        </section>

        <section id="section-integration" className="scroll-mt-28 space-y-3">
          <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
            {t("settings.categoryIntegration")}
          </h2>
          <WithingsSection id="withings" isAuthenticated={isAuthenticated} />
          {serviceAvailability.moodLogGlobal !== false && (
            <MoodLogSection t={t} />
          )}
          <InsightsSettingsSection
            id="insights"
            isAuthenticated={isAuthenticated}
          />
        </section>

        {serviceAvailability.apiGlobal && (
          <section id="section-api" className="scroll-mt-28 space-y-3">
            <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
              {t("settings.categoryApi")}
            </h2>
            <ApiEndpointsSection id="api-endpoints" />
            <ApiTokensSection
              id="api-tokens"
              isAuthenticated={isAuthenticated}
            />
          </section>
        )}

        <section id="section-export" className="scroll-mt-28 space-y-3">
          <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
            {t("settings.export")}
          </h2>
          <ExportSection id="export" />
        </section>

        <section id="section-danger-zone" className="scroll-mt-28 space-y-3">
          <h2 className="text-muted-foreground text-sm font-semibold tracking-wider uppercase">
            {t("settings.dangerZoneTitle")}
          </h2>
          <DataResetSection id="daten" />
        </section>
      </div>
    </div>
  );
}

/* ─────────────────────── Passkey List ─────────────────────── */

interface PasskeyInfo {
  id: string;
  name: string;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  createdAt: string;
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
      const res = await fetch(`/api/auth/passkeys/${id}`, {
        method: "DELETE",
      });
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

/* ─────────────────────── Withings Integration ─────────────────────── */

function WithingsSection({
  id,
  isAuthenticated,
}: {
  id: string;
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncMsgType, setSyncMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const [credsMsgType, setCredsMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["withings", "status"],
    queryFn: async () => {
      const res = await fetch("/api/withings/status");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as {
        connected: boolean;
        configured: boolean;
        lastSyncedAt?: string | null;
        connectedAt?: string;
        tokenExpired?: boolean;
      };
    },
    enabled: isAuthenticated,
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/withings/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["withings"] });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncMsg(null);
    setSyncMsgType(null);
    try {
      const res = await fetch("/api/withings/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      const json = await res.json();
      if (res.ok) {
        setSyncMsg(
          fullSync
            ? t("settings.withingsFullSyncResult", {
                count: json.data.imported,
              })
            : t("settings.withingsSyncResult", { count: json.data.imported }),
        );
        setSyncMsgType("success");
        void invalidateKeys(queryClient, measurementDependentKeys);
      } else {
        setSyncMsg(json.error || t("settings.withingsSyncFailed"));
        setSyncMsgType("error");
      }
    } catch {
      setSyncMsg(t("settings.withingsSyncFailed"));
      setSyncMsgType("error");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredsSaving(true);
    setCredsMsg(null);
    setCredsMsgType(null);

    try {
      const res = await fetch("/api/withings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg(t("settings.withingsCredentialsSaved"));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: ["withings"] });
      } else {
        try {
          const json = await res.json();
          setCredsMsg(json.error || t("settings.savingError"));
        } catch {
          setCredsMsg(t("settings.savingError"));
        }
        setCredsMsgType("error");
      }
    } catch {
      setCredsMsg(t("common.networkError"));
      setCredsMsgType("error");
    }
    setCredsSaving(false);
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link2 className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.withings")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status?.configured && !status?.connected && (
            <Badge variant="outline" className="text-xs">
              {t("settings.configured")}
            </Badge>
          )}
          {status?.connected && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("settings.withingsConnected")}
            </Badge>
          )}
          {status?.lastSyncedAt && (
            <Badge variant="outline" className="text-xs">
              {t("settings.withingsLastSync")}:{" "}
              {formatDateTime(status.lastSyncedAt)}
            </Badge>
          )}
          {status?.tokenExpired && (
            <Badge variant="destructive" className="text-xs">
              {t("settings.withingsTokenExpired")}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.withingsDescription")}
      </p>

      <div className="mt-4 space-y-4">
        {/* Credentials section */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">
            {t("settings.withingsCredentials")}
          </h3>
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="w-clientid">
                  {t("settings.withingsClientId")}
                </Label>
                <Input
                  id="w-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.withingsCredentialsSavedPlaceholder")
                      : t("settings.withingsClientId")
                  }
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="w-secret">
                  {t("settings.withingsClientSecret")}
                </Label>
                <PasswordInput
                  id="w-secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.withingsCredentialsSavedPlaceholderSecret")
                      : t("settings.withingsClientSecret")
                  }
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="invisible">{t("common.save")}</Label>
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  className="h-9 w-full"
                  disabled={
                    credsSaving || !clientId.trim() || !clientSecret.trim()
                  }
                >
                  {credsSaving ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t("settings.withingsSaveCredentials")}
                </Button>
              </div>
            </div>
            {credsMsg && (
              <p
                role="alert"
                className={`text-sm ${credsMsgType === "success" ? "text-dracula-green" : "text-destructive"}`}
              >
                {credsMsg}
              </p>
            )}
          </form>
        </div>

        {/* Connection status */}
        {status?.connected ? (
          <>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSync(false)}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.withingsSync")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={syncing}>
                    {syncing ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    )}
                    {t("settings.withingsFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.withingsFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.withingsFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.withingsSynchronize")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                  >
                    <Unlink className="mr-1 h-3.5 w-3.5" />
                    {t("settings.withingsDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.withingsDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.withingsDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.withingsDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {syncMsg && (
              <p
                role="alert"
                className={`text-sm ${syncMsgType === "success" ? "text-dracula-green" : "text-destructive"}`}
              >
                {syncMsg}
              </p>
            )}
          </>
        ) : status?.configured ? (
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/withings/connect";
            }}
          >
            <Link2 className="mr-2 h-4 w-4" />
            {t("settings.withingsConnect")}
          </Button>
        ) : (
          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-sm">
            {t("settings.withingsNoCredentials")}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────── API Tokens Section ─────────────────────── */

function ApiEndpointsSection({ id }: { id: string }) {
  const { t } = useTranslations();

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Key className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">
          {t("settings.apiEndpointsTitle")}
        </h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.apiEndpointsDescription")}
      </p>

      <div className="border-border mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[760px] text-xs">
          <thead>
            <tr className="bg-muted/40 text-muted-foreground border-b">
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointMethod")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointPath")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointAuth")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointExample")}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-3 py-2 font-medium">POST</td>
              <td className="px-3 py-2 font-mono">/api/ingest/medication</td>
              <td className="px-3 py-2 font-mono">
                Authorization: Bearer hlk_...
              </td>
              <td className="px-3 py-2 font-mono">
                {`{ "medicationName": "...", "scheduledFor": "..." }`}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ApiTokenInfo {
  id: string;
  name: string;
  permissions: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revoked: boolean;
}

function ApiTokensSection({
  id,
  isAuthenticated,
}: {
  id: string;
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const [showRevokedTokens, setShowRevokedTokens] = useState(false);

  const { data: tokens } = useQuery({
    queryKey: ["tokens"],
    queryFn: async () => {
      const res = await fetch("/api/tokens");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as ApiTokenInfo[];
    },
    enabled: isAuthenticated,
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setTokenMsg(null);
    setNewToken(null);

    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const json = await res.json();
      if (res.ok) {
        setNewToken(json.data.token);
        setNewName("");
        queryClient.invalidateQueries({ queryKey: ["tokens"] });
      } else {
        setTokenMsg(json.error || t("common.error"));
      }
    } catch {
      setTokenMsg(t("common.networkError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(tokenId: string) {
    const res = await fetch(`/api/tokens/${tokenId}`, { method: "DELETE" });
    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
    }
  }

  const activeTokens = (tokens ?? []).filter((tok) => !tok.revoked);
  const revokedTokens = (tokens ?? []).filter((tok) => tok.revoked);
  const latestActiveUse = activeTokens.reduce<string | null>((latest, tok) => {
    if (!tok.lastUsedAt) return latest;
    if (!latest || new Date(tok.lastUsedAt) > new Date(latest)) {
      return tok.lastUsedAt;
    }
    return latest;
  }, null);

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Key className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.apiTokens")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeTokens.length > 0 && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("settings.configured")}
            </Badge>
          )}
          {latestActiveUse && (
            <Badge variant="outline" className="text-xs">
              {t("settings.tokenTableLastUsed")}:{" "}
              {formatDateTime(latestActiveUse)}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.apiTokensDescription")}
      </p>

      <div className="mt-4 space-y-4">
        {/* Create new token */}
        <form onSubmit={handleCreate} className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("settings.tokenNamePlaceholder")}
            maxLength={100}
            className="flex-1"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={creating || !newName.trim()}
          >
            {creating && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {t("common.create")}
          </Button>
        </form>

        {/* New token display */}
        {newToken && (
          <div className="bg-dracula-green/10 rounded-lg p-3 text-sm">
            <p className="text-dracula-green mb-1 font-medium">
              {t("settings.tokenCreated")}
            </p>
            <code className="bg-muted block rounded p-2 font-mono text-xs break-all">
              {newToken}
            </code>
          </div>
        )}

        {tokenMsg && (
          <p role="alert" className="text-destructive text-sm">
            {tokenMsg}
          </p>
        )}

        {/* Token table (active) */}
        <div>
          <p className="mb-2 text-sm font-medium">
            {t("settings.activeTokensTitle")}
          </p>
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="bg-muted/40 text-muted-foreground border-b text-xs">
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableName")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTablePermissions")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableStatus")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableCreated")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableLastUsed")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("settings.tokenTableActions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {activeTokens.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-muted-foreground px-3 py-4 text-center text-sm"
                    >
                      {t("settings.noActiveTokens")}
                    </td>
                  </tr>
                )}
                {activeTokens.map((tok, index) => {
                  const isExpired =
                    tok.expiresAt && new Date(tok.expiresAt) < new Date();
                  return (
                    <tr
                      key={tok.id}
                      className={index % 2 === 0 ? "bg-muted/20" : ""}
                    >
                      <td className="px-3 py-2 font-medium">{tok.name}</td>
                      <td className="text-muted-foreground px-3 py-2 text-xs">
                        {tok.permissions.join(", ")}
                      </td>
                      <td className="px-3 py-2">
                        {isExpired ? (
                          <Badge variant="destructive" className="text-xs">
                            {t("settings.tokenExpired")}
                          </Badge>
                        ) : (
                          <Badge className="bg-dracula-green/15 text-dracula-green text-xs">
                            {t("settings.tokenActive")}
                          </Badge>
                        )}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                        {formatDate(tok.createdAt)}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                        {tok.lastUsedAt
                          ? formatDateTime(tok.lastUsedAt)
                          : t("settings.tokenNeverUsed")}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive h-8 w-8"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                {t("settings.tokenRevoke")}
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {t("settings.tokenRevokeDescription")}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>
                                {t("common.cancel")}
                              </AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => handleRevoke(tok.id)}
                              >
                                {t("settings.tokenRevoked")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Revoked tokens (collapsible, separate table) */}
        {revokedTokens.length > 0 && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowRevokedTokens((prev) => !prev)}
              className="text-foreground hover:text-primary flex items-center gap-1 text-sm font-medium transition-colors"
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${showRevokedTokens ? "rotate-180" : ""}`}
              />
              {t("settings.revokedTokensTitle", {
                count: revokedTokens.length,
              })}
            </button>
            {showRevokedTokens && (
              <div className="border-border overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="bg-muted/40 text-muted-foreground border-b text-xs">
                      <th className="px-3 py-2 text-left font-medium">
                        {t("settings.tokenTableName")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("settings.tokenTablePermissions")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("settings.tokenTableCreated")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("settings.tokenTableLastUsed")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {revokedTokens.map((tok, index) => (
                      <tr
                        key={tok.id}
                        className={index % 2 === 0 ? "bg-muted/20" : ""}
                      >
                        <td className="px-3 py-2 font-medium">{tok.name}</td>
                        <td className="text-muted-foreground px-3 py-2 text-xs">
                          {tok.permissions.join(", ")}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                          {formatDate(tok.createdAt)}
                        </td>
                        <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                          {tok.lastUsedAt
                            ? formatDateTime(tok.lastUsedAt)
                            : t("settings.tokenNeverUsed")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────── Export Section ─────────────────────── */

function ExportSection({ id }: { id: string }) {
  const { t, locale } = useTranslations();
  const [exporting, setExporting] = useState(false);
  const [generatingReport, setGeneratingReport] = useState(false);

  async function handleExport(format: "csv" | "json") {
    setExporting(true);
    try {
      const res = await fetch(`/api/export?format=${format}&type=all`);
      if (!res.ok) return;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `healthlog-export-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  async function handleDoctorReport() {
    setGeneratingReport(true);
    try {
      const res = await fetch("/api/doctor-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 90 }),
      });
      if (!res.ok) return;
      const json = await res.json();

      const { generateDoctorReportPDF } =
        await import("@/lib/doctor-report-pdf");
      const doc = generateDoctorReportPDF(json.data, { t, locale });
      const fileSlug = locale === "de" ? "gesundheitsbericht" : "health-report";
      doc.save(`${fileSlug}-${new Date().toISOString().slice(0, 10)}.pdf`);
    } finally {
      setGeneratingReport(false);
    }
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <Download className="text-primary h-5 w-5" />
        <h2 className="text-lg font-semibold">{t("settings.export")}</h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.exportDescription")}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleExport("json")}
          disabled={exporting}
        >
          {exporting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {t("settings.exportJson")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleExport("csv")}
          disabled={exporting}
        >
          {exporting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {t("settings.exportCsv")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleDoctorReport}
          disabled={generatingReport}
        >
          {generatingReport && (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          )}
          {t("settings.doctorReport")}
        </Button>
      </div>
    </div>
  );
}

/* ─────────────────────── Data Reset Section ─────────────────────── */

function DataResetSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  async function handleDeleteAllData() {
    setDeleting(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await fetch("/api/settings/data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMsg(json.error || t("settings.dangerZoneDeleteFailed"));
        setMsgType("error");
        return;
      }

      await queryClient.invalidateQueries();
      setMsg(t("settings.dangerZoneSuccess"));
      setMsgType("success");
    } catch {
      setMsg(t("settings.dangerZoneDeleteFailed"));
      setMsgType("error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="text-destructive h-5 w-5" />
        <h2 className="text-destructive text-lg font-semibold">
          {t("settings.dangerZone")}
        </h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.dangerZoneDescription")}
      </p>

      <div className="mt-4">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" disabled={deleting}>
              {deleting ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.dangerZone")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.dangerZoneConfirm")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.dangerZoneConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={handleDeleteAllData}
              >
                {t("settings.finalDelete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {msg && (
        <p
          role="alert"
          className={`mt-3 text-sm ${msgType === "success" ? "text-dracula-green" : "text-destructive"}`}
        >
          {msg}
        </p>
      )}
    </div>
  );
}

/* ─────────────────────── Telegram Notifications ─────────────────────── */

function TelegramSection({
  id,
  isAuthenticated,
}: {
  id: string;
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["telegram", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings/telegram");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as {
        enabled: boolean;
        hasBotToken: boolean;
        chatId: string | null;
      };
    },
    enabled: isAuthenticated,
  });

  const [enabled, setEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);
  if (settings && !initialized) {
    setEnabled(settings.enabled);
    if (settings.chatId) setChatId(settings.chatId);
    setInitialized(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setMsgType(null);

    const body: Record<string, unknown> = { enabled };
    if (botToken.trim()) body.botToken = botToken.trim();
    if (chatId !== (settings?.chatId ?? "")) body.chatId = chatId;

    const res = await fetch("/api/settings/telegram", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setMsg(t("settings.telegramSaved"));
      setMsgType("success");
      setBotToken("");
      queryClient.invalidateQueries({ queryKey: ["telegram"] });
    } else {
      const json = await res.json();
      setMsg(json.error || t("settings.savingError"));
      setMsgType("error");
    }
    setSaving(false);
  }

  async function handleTest() {
    setTesting(true);
    setMsg(null);
    setMsgType(null);

    const res = await fetch("/api/settings/telegram/test", { method: "POST" });
    if (res.ok) {
      setMsg(t("settings.testSent"));
      setMsgType("success");
    } else {
      const json = await res.json();
      setMsg(json.error || t("common.error"));
      setMsgType("error");
    }
    setTesting(false);
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageCircle className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.telegram")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {settings?.hasBotToken && settings?.chatId && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("settings.configured")}
            </Badge>
          )}
          {settings?.enabled && (
            <Badge variant="outline" className="text-xs">
              {t("common.enabled")}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.telegramDescription")}
      </p>

      <div className="mt-4 space-y-4">
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tg-token">{t("settings.botToken")}</Label>
              <PasswordInput
                id="tg-token"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={
                  settings?.hasBotToken
                    ? t("settings.withingsCredentialsSavedPlaceholder")
                    : "123456:ABC-DEF..."
                }
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tg-chatid">{t("settings.chatId")}</Label>
              <Input
                id="tg-chatid"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="123456789"
                maxLength={50}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              id="tg-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
            <Label htmlFor="tg-enabled" className="cursor-pointer">
              {t("settings.enableNotifications")}
            </Label>
          </div>

          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-xs">
            <p>{t("settings.telegramStep1")}</p>
            <p>{t("settings.telegramStep2")}</p>
            <p>{t("settings.telegramStep3")}</p>
          </div>

          {msg && (
            <p
              role="alert"
              className={`text-sm ${
                msgType === "success"
                  ? "text-dracula-green"
                  : "text-destructive"
              }`}
            >
              {msg}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={testing || !settings?.hasBotToken}
              onClick={handleTest}
            >
              {testing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {t("settings.testMessage")}
            </Button>
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
    </div>
  );
}

/* ─────────────────────── ntfy Settings ─────────────────────── */

interface NtfySettings {
  enabled: boolean;
  serverUrl: string;
  topic: string;
  hasAuthToken: boolean;
}

function NtfySection({
  id,
  isAuthenticated,
}: {
  id: string;
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [serverUrl, setServerUrl] = useState("https://ntfy.sh");
  const [topic, setTopic] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveMsgType, setSaveMsgType] = useState<"success" | "error" | null>(
    null,
  );

  const { data: settings } = useQuery({
    queryKey: ["settings", "ntfy"],
    queryFn: async () => {
      const res = await fetch("/api/settings/ntfy");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as NtfySettings;
    },
    enabled: isAuthenticated,
  });

  // Sync from server
  useState(() => {
    if (settings) {
      setServerUrl(settings.serverUrl);
      setTopic(settings.topic);
    }
  });

  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch("/api/settings/ntfy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverUrl,
          topic,
          authToken: authToken || undefined,
          enabled,
        }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || t("common.error"));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "ntfy"] });
      setSaveMsg(t("settings.saved"));
      setSaveMsgType("success");
      setAuthToken("");
    },
    onError: (err: Error) => {
      setSaveMsg(err.message);
      setSaveMsgType("error");
    },
  });

  const test = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/settings/ntfy/test", { method: "POST" });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || t("common.error"));
      }
    },
    onSuccess: () => {
      setSaveMsg(t("settings.testSent"));
      setSaveMsgType("success");
    },
    onError: (err: Error) => {
      setSaveMsg(err.message);
      setSaveMsgType("error");
    },
  });

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bell className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.ntfy")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {settings?.serverUrl && settings?.topic && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("settings.configured")}
            </Badge>
          )}
          {settings?.enabled && (
            <Badge variant="outline" className="text-xs">
              {t("common.enabled")}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.ntfyDescription")}
      </p>

      <div className="mt-4 space-y-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="ntfy-toggle">{t("settings.ntfyEnable")}</Label>
          <Switch
            id="ntfy-toggle"
            checked={settings?.enabled ?? false}
            onCheckedChange={(checked) => save.mutate(checked)}
            disabled={save.isPending}
          />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(settings?.enabled ?? false);
          }}
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ntfy-server">{t("settings.ntfyServer")}</Label>
              <Input
                id="ntfy-server"
                placeholder="https://ntfy.sh"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ntfy-topic">{t("settings.ntfyTopic")}</Label>
              <Input
                id="ntfy-topic"
                placeholder="healthlog-mein-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="ntfy-auth">{t("settings.ntfyAuthToken")}</Label>
              <PasswordInput
                id="ntfy-auth"
                placeholder={
                  settings?.hasAuthToken
                    ? t("settings.saved")
                    : t("common.optional")
                }
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {t("settings.ntfyAuthTokenHint")}
              </p>
            </div>
          </div>

          {saveMsg && (
            <p
              role="alert"
              className={`text-sm ${saveMsgType === "success" ? "text-dracula-green" : "text-destructive"}`}
            >
              {saveMsg}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={test.isPending || !settings?.enabled}
              onClick={() => test.mutate()}
            >
              {test.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.testMessage")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              )}
              {t("common.save")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────────────────── Web Push Notifications ─────────────────────── */

function WebPushSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const [isDenied, setIsDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  useEffect(() => {
    async function checkSubscription() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setIsSupported(false);
        setLoading(false);
        return;
      }

      if (Notification.permission === "denied") {
        setIsDenied(true);
        setLoading(false);
        return;
      }

      try {
        const registration =
          await navigator.serviceWorker.getRegistration("/sw.js");
        if (registration) {
          const subscription = await registration.pushManager.getSubscription();
          setIsSubscribed(!!subscription);
        }
      } catch {
        // Ignore errors during check
      }
      setLoading(false);
    }

    checkSubscription();
  }, []);

  async function handleSubscribe() {
    setActionLoading(true);
    setMsg(null);
    setMsgType(null);

    try {
      // Get VAPID public key from server
      const vapidRes = await fetch("/api/notifications/vapid");
      if (!vapidRes.ok) {
        setMsg(t("settings.webPushNotConfigured"));
        setMsgType("error");
        setActionLoading(false);
        return;
      }
      const vapidData = await vapidRes.json();
      const vapidPublicKey = vapidData.data.publicKey;

      // Register service worker
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      // Subscribe to push
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(vapidPublicKey),
      });

      const subJson = subscription.toJSON();

      // Save subscription on server
      const res = await fetch("/api/notifications/web-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: {
            p256dh: subJson.keys?.p256dh ?? "",
            auth: subJson.keys?.auth ?? "",
          },
        }),
      });

      if (res.ok) {
        setIsSubscribed(true);
        setMsg(t("settings.webPushSubscribed"));
        setMsgType("success");
      } else {
        setMsg(t("settings.webPushSubscribeFailed"));
        setMsgType("error");
      }
    } catch {
      if (Notification.permission === "denied") {
        setIsDenied(true);
        setMsg(t("settings.webPushDenied"));
      } else {
        setMsg(t("settings.webPushSubscribeFailed"));
      }
      setMsgType("error");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUnsubscribe() {
    setActionLoading(true);
    setMsg(null);
    setMsgType(null);

    try {
      const registration =
        await navigator.serviceWorker.getRegistration("/sw.js");
      if (registration) {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          // Delete from server
          await fetch("/api/notifications/web-push", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          });

          await subscription.unsubscribe();
        }
      }

      setIsSubscribed(false);
      setMsg(t("settings.webPushUnsubscribed"));
      setMsgType("success");
    } catch {
      setMsg(t("settings.webPushSubscribeFailed"));
      setMsgType("error");
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <BellRing className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.webPush")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!loading && isSubscribed && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("settings.configured")}
            </Badge>
          )}
          {!loading && isSubscribed && (
            <Badge variant="outline" className="text-xs">
              {t("settings.webPushActive")}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.webPushDescription")}
      </p>

      <div className="mt-4 space-y-3">
        {loading ? (
          <div className="flex items-center gap-2">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          </div>
        ) : !isSupported ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.webPushNotSupported")}
          </p>
        ) : isDenied ? (
          <p className="text-destructive text-sm">
            {t("settings.webPushDenied")}
          </p>
        ) : isSubscribed ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleUnsubscribe}
            disabled={actionLoading}
          >
            {actionLoading && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            )}
            {t("settings.webPushUnsubscribe")}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={handleSubscribe}
            disabled={actionLoading}
          >
            {actionLoading ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <BellRing className="mr-1 h-3.5 w-3.5" />
            )}
            {t("settings.webPushSubscribe")}
          </Button>
        )}

        {msg && (
          <p
            role="alert"
            className={`text-sm ${msgType === "success" ? "text-dracula-green" : "text-destructive"}`}
          >
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

/** Convert a URL-safe base64 string to an ArrayBuffer (for VAPID key). */
function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; ++i) {
    view[i] = raw.charCodeAt(i);
  }
  return buffer;
}

/* ─────────────────────── moodLog Integration ─────────────────────── */

function MoodLogSection({ t }: { t: (key: string) => string }) {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ["moodlog-status"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/moodlog/status");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as {
        configured: boolean;
        enabled: boolean;
        lastSyncedAt: string | null;
        entryCount: number;
        webhookSecret: string | null;
      };
    },
  });

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    const res = await fetch("/api/settings/moodlog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim(), apiKey: apiKey.trim() }),
    });
    if (res.ok) {
      setMsg(t("settings.moodLogSaved"));
      setMsgType("success");
      setUrl("");
      setApiKey("");
      await refetchStatus();
    } else {
      const json = await res.json();
      setMsg(json.error || t("settings.savingError"));
      setMsgType("error");
    }
    setSaving(false);
  }

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setMsg(null);
    try {
      const res = await fetch("/api/integrations/moodlog/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      if (res.ok) {
        const json = await res.json();
        setMsg(
          t("settings.moodLogSyncResult").replace(
            "{count}",
            String(json.data.imported),
          ),
        );
        setMsgType("success");
        await refetchStatus();
      } else {
        setMsg(t("settings.moodLogSyncFailed"));
        setMsgType("error");
      }
    } catch {
      setMsg(t("settings.moodLogSyncFailed"));
      setMsgType("error");
    }
    setSyncing(false);
  }

  async function handleDisconnect() {
    const res = await fetch("/api/settings/moodlog", { method: "DELETE" });
    if (res.ok) {
      setMsg(t("settings.moodLogDisconnected"));
      setMsgType("success");
      await refetchStatus();
    }
  }

  return (
    <div
      id="moodlog"
      className="bg-card border-border scroll-mt-28 space-y-4 rounded-xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Smile className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">
            <a
              href="https://moodlog.onback.io"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {t("settings.moodLogTitle")}
            </a>
          </h2>
        </div>
        {status?.configured && (
          <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
            {status.enabled
              ? t("settings.withingsConnected")
              : t("settings.configured")}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {t("settings.moodLogDescription")}
      </p>

      {/* Credentials form */}
      <form onSubmit={handleSave} className="space-y-3">
        <div>
          <Label>{t("settings.moodLogUrl")}</Label>
          <Input
            type="url"
            placeholder={t("settings.moodLogUrlPlaceholder")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div>
          <Label>{t("settings.moodLogApiKey")}</Label>
          <PasswordInput
            placeholder={
              status?.configured
                ? t("settings.withingsCredentialsSavedPlaceholder")
                : t("settings.moodLogApiKeyPlaceholder")
            }
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <Button
          type="submit"
          disabled={saving || (!url.trim() && !apiKey.trim())}
          size="sm"
        >
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          {t("common.save")}
        </Button>
      </form>

      {/* Connected state */}
      {status?.configured && (
        <div className="space-y-3 border-t pt-3">
          {/* Webhook Secret */}
          {status.webhookSecret && (
            <div>
              <Label>{t("settings.moodLogWebhookSecret")}</Label>
              <div className="flex gap-2">
                <Input
                  value={status.webhookSecret}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(status.webhookSecret!);
                    setMsg(t("common.copied"));
                    setMsgType("success");
                  }}
                >
                  {t("common.copied").replace("!", "")}
                </Button>
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                {t("settings.moodLogWebhookSecretHelp")}
              </p>
            </div>
          )}

          {/* Status info */}
          <div className="flex flex-wrap gap-4 text-sm">
            {status.lastSyncedAt && (
              <span>
                {t("settings.moodLogLastSync")}:{" "}
                {formatDateTime(status.lastSyncedAt)}
              </span>
            )}
            <span>
              {t("settings.moodLogEntries")}: {status.entryCount}
            </span>
          </div>

          {/* Sync buttons */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={syncing}
              onClick={() => handleSync(false)}
            >
              {syncing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <RefreshCw className="mr-2 h-4 w-4" />
              {t("settings.moodLogSync")}
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={syncing}>
                  <Download className="mr-2 h-4 w-4" />
                  {t("settings.moodLogFullSync")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("settings.moodLogFullSyncTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("settings.moodLogFullSyncDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => handleSync(true)}>
                    {t("settings.moodLogFullSync")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Unlink className="mr-2 h-4 w-4" />
                  {t("settings.moodLogDisconnect")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("settings.moodLogDisconnectTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("settings.moodLogDisconnectDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDisconnect}>
                    {t("settings.moodLogDisconnect")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}

      {/* Status message */}
      {msg && (
        <p
          role="alert"
          className={`text-sm ${msgType === "error" ? "text-destructive" : "text-dracula-green"}`}
        >
          {msg}
        </p>
      )}
    </div>
  );
}

/* ─────────────────────── OpenAI Insights Settings ─────────────────────── */

function InsightsSettingsSection({
  id,
  isAuthenticated,
}: {
  id: string;
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["insights", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/insights/settings");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as {
        codexStatus: string;
        codexConnectedAt: string | null;
        hasAdminKey: boolean;
        privacyMode: string;
        lastInsightAt: string | null;
      };
    },
    enabled: isAuthenticated,
  });

  const updateSettings = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch("/api/insights/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });

  // Handle OAuth callback query params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("codex_connected") === "true") {
      setMsg(t("settings.codexConnected"));
      setMsgType("success");
      queryClient.invalidateQueries({ queryKey: ["insights"] });
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("codex_error")) {
      setMsg(t("settings.codexConnectionFailed"));
      setMsgType("error");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [queryClient, t]);

  const hasProvider =
    settings?.codexStatus === "connected" || settings?.hasAdminKey;

  async function handleConnect() {
    window.location.href = "/api/auth/codex/authorize";
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/auth/codex/disconnect", {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error);
      }
      setMsg(t("settings.codexDisconnected"));
      setMsgType("success");
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t("settings.savingError"));
      setMsgType("error");
    } finally {
      setDisconnecting(false);
    }
  }

  async function togglePrivacyMode() {
    const newMode = settings?.privacyMode === "raw" ? "aggregated" : "raw";
    await updateSettings.mutateAsync({ privacyMode: newMode });
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await fetch("/api/insights/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          setMsg(t("settings.regenerateRateLimit"));
        } else {
          setMsg(json.error || t("settings.savingError"));
        }
        setMsgType("error");
        return;
      }
      setMsg(t("settings.regenerateSuccess"));
      setMsgType("success");
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    } catch {
      setMsg(t("settings.savingError"));
      setMsgType("error");
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.kiInsights")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {settings?.codexStatus === "connected" && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              ChatGPT verbunden
            </Badge>
          )}
          {settings?.codexStatus !== "connected" && settings?.hasAdminKey && (
            <Badge className="border-dracula-purple/30 bg-dracula-purple/15 text-dracula-purple">
              Admin-KI aktiv
            </Badge>
          )}
          {settings?.codexStatus === "expired" && (
            <Badge className="border-dracula-orange/30 bg-dracula-orange/15 text-dracula-orange">
              Verbindung abgelaufen
            </Badge>
          )}
          {settings?.lastInsightAt && (
            <Badge variant="outline" className="text-xs">
              {t("settings.lastGeneratedAt")}:{" "}
              {formatDateTime(settings.lastInsightAt)}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.kiInsightsDescription")}
      </p>

      <div className="mt-4 space-y-4">
        {/* ChatGPT Connection */}
        <div className="bg-muted/50 rounded-lg p-4">
          {settings?.codexStatus === "connected" ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">ChatGPT verbunden</p>
                <p className="text-muted-foreground text-xs">
                  Insights werden über dein ChatGPT-Abo generiert — keine
                  zusätzlichen Kosten.
                  {settings.codexConnectedAt && (
                    <>
                      {" "}
                      Verbunden seit {formatDateTime(settings.codexConnectedAt)}
                      .
                    </>
                  )}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive shrink-0"
                onClick={handleDisconnect}
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 h-4 w-4" />
                )}
                Trennen
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">Mit ChatGPT verbinden</p>
                <p className="text-muted-foreground text-xs">
                  Verbinde dein ChatGPT Pro/Max-Konto um KI-gestützte
                  Gesundheitsanalysen basierend auf aktuellen medizinischen
                  Leitlinien zu erhalten. Keine zusätzlichen API-Kosten.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleConnect}
                className="w-full sm:w-auto"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Mit ChatGPT verbinden
              </Button>
              {settings?.hasAdminKey && (
                <p className="text-muted-foreground text-xs">
                  Alternativ nutzt HealthLog den vom Administrator
                  konfigurierten KI-Anbieter.
                </p>
              )}
            </div>
          )}
        </div>

        {msg && (
          <p
            role="alert"
            className={`text-sm ${msgType === "success" ? "text-dracula-green" : "text-destructive"}`}
          >
            {msg}
          </p>
        )}

        {/* Privacy Mode */}
        {hasProvider && (
          <div className="bg-muted/50 rounded-lg p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="pr-2">
                <p className="text-sm font-medium">{t("settings.rawData")}</p>
                <p className="text-muted-foreground text-xs">
                  {settings?.privacyMode === "raw"
                    ? t("settings.rawDataOnDescription")
                    : t("settings.rawDataOffDescription")}
                </p>
              </div>
              <div className="ml-2 shrink-0">
                <Switch
                  checked={settings?.privacyMode === "raw"}
                  onCheckedChange={togglePrivacyMode}
                />
              </div>
            </div>
            {settings?.privacyMode === "raw" && (
              <div className="mt-2 rounded-lg bg-orange-500/10 p-2 text-xs text-orange-400">
                {t("settings.rawDataWarning")}
              </div>
            )}
          </div>
        )}

        {/* Regenerate Reports */}
        {hasProvider && (
          <Button
            variant="outline"
            onClick={handleRegenerate}
            disabled={regenerating}
            className="w-full sm:w-auto"
          >
            {regenerating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t("settings.regenerateInsights")}
          </Button>
        )}

        {/* Multi-provider AI selection (per-user override) */}
        <UserAIProviderSubsection />
      </div>
    </div>
  );
}

/* ─────────────────────── User AI Provider Override ─────────────────────── */

function UserAIProviderSubsection() {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [anthropicKey, setAnthropicKey] = useState<string>("");
  const [localKey, setLocalKey] = useState<string>("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<boolean>(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);

  const { data, isLoading } = useQuery({
    queryKey: ["user", "ai-provider"],
    queryFn: async () => {
      const res = await fetch("/api/user/ai-provider");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as {
        provider: string | null;
        model: string | null;
        baseUrl: string | null;
        hasAnthropicKey: boolean;
        anthropicKeyPreview: string | null;
        hasLocalKey: boolean;
      };
    },
  });

  useEffect(() => {
    if (!data) return;
    // Sync-from-server pattern: form draft state is initialised from the
    // fetched user record. Could be reworked into a derived-state approach,
    // but that's a non-trivial refactor of this monolithic settings page —
    // tracked for the 1.4.0 settings split.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProvider(data.provider ?? "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModel(data.model ?? "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBaseUrl(data.baseUrl ?? "");
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: provider || null,
        model: model || null,
        baseUrl: baseUrl || null,
      };
      if (anthropicKey.trim()) body.anthropicKey = anthropicKey.trim();
      if (localKey.trim()) body.localKey = localKey.trim();
      const res = await fetch("/api/user/ai-provider", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
    },
    onSuccess: () => {
      setSaveMsg("Gespeichert");
      setSaveOk(true);
      setAnthropicKey("");
      setLocalKey("");
      queryClient.invalidateQueries({ queryKey: ["user", "ai-provider"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
    onError: (e) => {
      setSaveMsg(e instanceof Error ? e.message : "Fehler");
      setSaveOk(false);
    },
  });

  async function runTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      // v1.4: pass the *current* dropdown / input selection so the test
      // honours unsaved changes. Plaintext keys never persist server-side.
      const overrideBody: Record<string, string> = {};
      if (provider) overrideBody.provider = provider;
      if (model.trim()) overrideBody.model = model.trim();
      if (baseUrl.trim()) overrideBody.baseUrl = baseUrl.trim();
      if (anthropicKey.trim()) overrideBody.anthropicKey = anthropicKey.trim();
      if (localKey.trim()) overrideBody.localKey = localKey.trim();
      const hasOverride = Object.keys(overrideBody).length > 0;
      const res = await fetch("/api/ai/test", {
        method: "POST",
        headers: hasOverride ? { "Content-Type": "application/json" } : {},
        body: hasOverride ? JSON.stringify(overrideBody) : undefined,
      });
      const json = await res.json();
      if (!res.ok) {
        setTestMsg(json.error || `HTTP ${res.status}`);
        setTestOk(false);
        return;
      }
      setTestMsg(
        `OK — ${json.data.providerType} (${json.data.model})${
          json.data.tokensUsed ? `, ${json.data.tokensUsed} tokens` : ""
        }`,
      );
      setTestOk(true);
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : "Test fehlgeschlagen");
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  }

  if (isLoading) return null;

  return (
    <div className="bg-muted/50 mt-2 rounded-lg p-4">
      <div className="mb-3">
        <p className="text-sm font-medium">KI-Provider (persönlich)</p>
        <p className="text-muted-foreground text-xs">
          Eigener KI-Anbieter überschreibt die Admin-Einstellung. Leer lassen
          für Standard.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="ai-provider-select">Provider</Label>
          <select
            id="ai-provider-select"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="bg-background border-input mt-1 h-9 w-full rounded-md border px-2 text-sm"
          >
            <option value="">— Standard (Admin/Codex) —</option>
            <option value="OPENAI">OpenAI</option>
            <option value="ANTHROPIC">Anthropic (Claude)</option>
            <option value="LOCAL">Lokal (OpenAI-kompatibel)</option>
            <option value="CHATGPT_OAUTH">ChatGPT OAuth</option>
          </select>
        </div>

        <div>
          <Label htmlFor="ai-model-input">Modell</Label>
          <Input
            id="ai-model-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={
              provider === "ANTHROPIC"
                ? "claude-3-5-sonnet-latest"
                : provider === "LOCAL"
                  ? "llama3:8b"
                  : "gpt-4o-mini"
            }
            className="mt-1"
          />
        </div>

        {provider === "ANTHROPIC" && (
          <div className="sm:col-span-2">
            <Label htmlFor="ai-anthropic-key">
              Anthropic API Key
              {data?.hasAnthropicKey && (
                <span className="text-muted-foreground ml-2 text-xs">
                  (gespeichert {data.anthropicKeyPreview})
                </span>
              )}
            </Label>
            <PasswordInput
              id="ai-anthropic-key"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder="sk-ant-..."
              className="mt-1"
            />
          </div>
        )}

        {provider === "LOCAL" && (
          <>
            <div className="sm:col-span-2">
              <Label htmlFor="ai-base-url">Base URL</Label>
              <Input
                id="ai-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="ai-local-key">API Key (optional)</Label>
              <PasswordInput
                id="ai-local-key"
                value={localKey}
                onChange={(e) => setLocalKey(e.target.value)}
                placeholder={data?.hasLocalKey ? "(gespeichert)" : ""}
                className="mt-1"
              />
            </div>
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Speichern
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={runTest}
          disabled={testing}
        >
          {testing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          Verbindung testen
        </Button>
      </div>

      {saveMsg && (
        <p
          className={`mt-2 text-xs ${
            saveOk ? "text-dracula-green" : "text-destructive"
          }`}
        >
          {saveMsg}
        </p>
      )}
      {testMsg && (
        <p
          className={`mt-2 text-xs ${
            testOk ? "text-dracula-green" : "text-destructive"
          }`}
        >
          {testMsg}
        </p>
      )}
    </div>
  );
}
