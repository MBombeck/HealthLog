"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Compass,
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
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PasswordInput } from "@/components/ui/password-input";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format";
import { locales, localeLabels, type Locale } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";
import { describePasskeyError } from "@/lib/passkey-errors";
import { TimezonePicker } from "@/components/settings/timezone-picker";

interface PasskeyInfo {
  id: string;
  name: string;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  createdAt: string;
}

// v1.4.27 MB7 / CF-52 — the in-file `NATIVE_SELECT_CLASS` constant
// retired; the shared `<NativeSelect>` primitive owns the visual
// contract now. Existing `<select className={NATIVE_SELECT_CLASS}>`
// call sites in this file swapped to `<NativeSelect>` below.

export function AccountSection() {
  const { t, locale, setLocale } = useTranslations();
  const { user, isLoading, isAuthenticated, refetch } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState<string>("");
  const [timezone, setTimezone] = useState<string>("Europe/Berlin");
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

  // v1.4.15 Phase B5 — onboarding-tour replay state. Settings → Account
  // exposes a "Restart onboarding tour" button that resets the
  // server-side flag (`users.onboarding_tour_completed = false`) and
  // dispatches a `healthlog:tour-restart` window event so the dashboard's
  // <TourLauncher> picks it up immediately on the user's next nav. The
  // confirmation message goes through the same announce channel as
  // every other settings save (status: "success" | "error" | null).
  const [tourRestarting, setTourRestarting] = useState(false);
  const [tourMsg, setTourMsg] = useState<string | null>(null);
  const [tourMsgType, setTourMsgType] = useState<"success" | "error" | null>(
    null,
  );

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
    setTimezone(user.timezone || "Europe/Berlin");
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    setSaveMsgType(null);

    // The timezone is owned by a dedicated route (v1.4.25 W7) so the
    // resolver cache can be invalidated without piping the flag
    // through the bigger profile patch path. Run the two PUTs in
    // parallel — they're independent.
    const [profileRes, tzRes] = await Promise.all([
      fetch("/api/auth/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim() || null,
          heightCm: heightCm ? parseFloat(heightCm) : null,
          dateOfBirth: dateOfBirth || null,
          gender: gender || null,
        }),
      }),
      user && timezone && timezone !== user.timezone
        ? fetch("/api/auth/me/timezone", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ timezone }),
          })
        : Promise.resolve({ ok: true } as Response),
    ]);

    if (profileRes.ok && tzRes.ok) {
      setSaveMsg(t("settings.profileSaved"));
      setSaveMsgType("success");
      await refetch();
    } else if (!tzRes.ok) {
      // The dedicated tz endpoint owns the IANA validation error
      // text. Surface its message verbatim so the user sees
      // "Not a valid IANA timezone." instead of the generic save
      // failure copy.
      try {
        const json = (await (tzRes as Response).json()) as { error?: string };
        setSaveMsg(json.error || t("settings.timezoneInvalid"));
      } catch {
        setSaveMsg(t("settings.timezoneInvalid"));
      }
      setSaveMsgType("error");
    } else {
      const json = await profileRes.json();
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

  async function handleRestartTour() {
    setTourRestarting(true);
    setTourMsg(null);
    setTourMsgType(null);
    try {
      const res = await fetch("/api/onboarding/tour", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: false }),
      });
      if (!res.ok) {
        setTourMsg(t("settings.savingError"));
        setTourMsgType("error");
        return;
      }
      // Refetch the auth payload so `<TourLauncher>` re-evaluates
      // with the new flag, AND fire a window event so a launcher
      // already mounted on the dashboard reopens immediately
      // without waiting for a navigation.
      await refetch();
      try {
        window.dispatchEvent(new CustomEvent("healthlog:tour-restart"));
      } catch {
        /* ignore — only matters if the dashboard is already mounted */
      }
      setTourMsg(t("onboarding.tour.restartConfirmation"));
      setTourMsgType("success");
    } catch {
      setTourMsg(t("common.networkError"));
      setTourMsgType("error");
    } finally {
      setTourRestarting(false);
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
              {/* v1.4.33 F13 — `disabled` adds `opacity-50` to the input
                  primitive, which the maintainer's mobile pass read as
                  "empty placeholder text" because the username then
                  matches the muted-foreground colour exactly. Username
                  changes still aren't allowed, but `readOnly` keeps the
                  text crisp (full contrast) so it reads as a value, not
                  a hint. */}
              <Input
                id="username"
                value={user.username}
                readOnly
                autoComplete="username"
              />
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
                autoComplete="email"
                enterKeyHint="next"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="gender">{t("settings.gender")}</Label>
              <NativeSelect
                id="gender"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
              >
                <option value="">{t("settings.genderNone")}</option>
                <option value="MALE">{t("settings.genderMale")}</option>
                <option value="FEMALE">{t("settings.genderFemale")}</option>
              </NativeSelect>
              <p className="text-muted-foreground text-xs">
                {t("settings.genderHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="height">{t("settings.height")}</Label>
              <Input
                id="height"
                type="number"
                inputMode="decimal"
                enterKeyHint="next"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                placeholder="175"
                min={50}
                max={300}
                step={0.1}
              />
            </div>
          </div>

          {/* Date of birth + language share one paired grid row so the
              profile form keeps a single rhythm (every row two cells
              wide on sm+). Date of birth is the bottom of the
              biological-profile block; language is the only UI
              preference on this card. They sit together to close the
              "single-cell row" gap that broke the form's grid. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="dob">{t("settings.dateOfBirth")}</Label>
              <DateInput
                id="dob"
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
              <NativeSelect
                id="language-select"
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
              >
                {locales.map((loc) => (
                  <option key={loc} value={loc}>
                    {localeLabels[loc as Locale]}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-muted-foreground text-xs">
                {t("settings.languageDescription")}
              </p>
            </div>
          </div>

          <TimezonePicker value={timezone} onChange={setTimezone} />

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
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
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
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
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

      {/* Password card. v1.4.19 A6: action-button placement contract —
          on mobile (`<sm`) the action button stacks below the title +
          description and renders full-width; on desktop (`>=sm`) it
          right-aligns next to the title. The previous
          `flex items-center justify-between` pattern overflowed the
          card edge on Pixel 5 once button copy got longer than ~24 ch
          (the German "Passwort ändern" already pushes it; the tour
          card's "Restart onboarding tour" actually broke through the
          right border by ~48 px). */}
      <div className="bg-card border-border rounded-xl border p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Shield className="text-primary h-5 w-5" />
              <h2 className="text-lg font-semibold">
                {t("settings.passwordReset")}
              </h2>
            </div>
            <p className="text-muted-foreground text-xs">
              {t("settings.changePasswordDescription")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setPasswordDialogOpen(true)}
            className="w-full shrink-0 sm:w-auto"
          >
            {t("settings.changePassword")}
          </Button>
        </div>
      </div>

      {/* Tour replay card. v1.4.15 Phase B5: a one-shot button that
          resets `users.onboarding_tour_completed` on the server AND
          dispatches a window event so a dashboard already in the
          background reopens the spotlight tour immediately. v1.4.19
          A6 — same stack-on-mobile / right-align-on-desktop contract
          as the password card so both action surfaces look identical. */}
      <div className="bg-card border-border rounded-xl border p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Compass className="text-primary h-5 w-5" />
              <h2 className="text-lg font-semibold">
                {t("onboarding.tour.restart")}
              </h2>
            </div>
            <p className="text-muted-foreground text-xs">
              {t("onboarding.tour.restartHint")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={handleRestartTour}
            disabled={tourRestarting}
            data-testid="settings-restart-tour"
            className="w-full shrink-0 sm:w-auto"
          >
            {tourRestarting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Compass className="mr-2 h-4 w-4" />
            )}
            {t("onboarding.tour.restart")}
          </Button>
        </div>
        {tourMsg && (
          <p
            role="alert"
            className={`mt-2 text-xs ${
              tourMsgType === "success"
                ? "text-dracula-green"
                : "text-destructive"
            }`}
          >
            {tourMsg}
          </p>
        )}
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

          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="current-password">
                  {t("settings.currentPassword")}
                </Label>
                <PasswordInput
                  id="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-password">
                  {t("settings.newPassword")}
                </Label>
                <PasswordInput
                  id="new-password"
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
        <h3 className="text-sm font-semibold">{t("settings.passkeys")}</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("settings.noPasskeys")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold">
        {t("settings.registeredPasskeys")}
      </h3>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.passkeysDescription")}
      </p>
      {/* Phase A5 / B-mobile HIGH: the passkey table previously
          rendered with `min-w-[620px]` inside `overflow-x-auto`,
          which on a 393px viewport hid the right-most column —
          including the destructive delete action. Render the desktop
          table only at `≥ md`, and at `< md` paint a card-list where
          every passkey's name, device type, backup status, created
          date, and delete action are all visible without scrolling. */}
      {/* v1.4.33 — desktop table flips to card list at `lg` instead
          of `md` so iPad portrait (768 px = exactly the `md`
          inflection) lands on the card layout. The table needs
          ~620 px of column width to read; below that it scrolls
          horizontally and the destructive delete column is the one
          that disappears. */}
      <div className="border-border mt-3 hidden overflow-x-auto rounded-lg border lg:block">
        <table className="w-full text-sm">
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
                        aria-label={t("settings.deletePasskey")}
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

      {/* Mobile + tablet card list — < lg only. Each passkey gets
          its own card so the delete action stays visible and
          tap-targetable (44 px) without the user having to
          horizontally scroll through a wide table. v1.4.33 bumped
          the breakpoint from `md` to `lg` so iPad portrait (768 px)
          stays on the card layout instead of flipping between
          layouts on rotation. */}
      <ul
        className="mt-3 space-y-2 lg:hidden"
        data-testid="passkeys-mobile-list"
      >
        {passkeys.map((pk) => (
          <li
            key={pk.id}
            className="bg-card border-border rounded-lg border p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{pk.name}</p>
                {/* v1.4.27 MB7 / CF-75 — promote the device-type from
                    plain text to an outline Badge so the mobile card
                    list reads consistent with the desktop table's
                    "Single-device / Multi-device" column. Sits on the
                    same chip row as the backup status and date so all
                    metadata reads as a single horizontal stride. */}
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <Badge variant="outline" className="text-[11px]">
                    {DEVICE_TYPE_LABELS[pk.credentialDeviceType] ??
                      pk.credentialDeviceType}
                  </Badge>
                  <Badge
                    variant={pk.credentialBackedUp ? "secondary" : "outline"}
                    className="text-[11px]"
                  >
                    {pk.credentialBackedUp
                      ? t("settings.backedUp")
                      : t("common.no")}
                  </Badge>
                  <span className="text-muted-foreground">
                    {formatDate(pk.createdAt)}
                  </span>
                </div>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive min-h-11 min-w-11"
                    disabled={deletePasskey.isPending}
                    aria-label={t("settings.deletePasskey")}
                  >
                    <Trash2 className="h-4 w-4" />
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
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => deletePasskey.mutate(pk.id)}
                    >
                      {t("common.delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </li>
        ))}
      </ul>
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
