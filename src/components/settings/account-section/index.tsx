"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Shield, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  SeededFormDiscardDialog,
  useSeededFormDismissal,
} from "@/components/forms/use-seeded-form-dismissal";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PasswordInput } from "@/components/ui/password-input";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { locales, localeLabels, type Locale } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";
import { AboutMeSection } from "@/components/settings/about-me-section";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { TimezonePicker } from "@/components/settings/timezone-picker";
import { storeTimezone } from "@/lib/timezone-mirror";
import { TimeFormatSelect } from "@/components/settings/time-format-select";
import { DateFormatSelect } from "@/components/settings/date-format-select";
import { UnitPreferenceSelect } from "@/components/settings/unit-preference-select";
import { CycleTrackingCard } from "@/components/settings/cycle-tracking-card";
import { detectBrowserTimezone } from "@/lib/tz/format";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import {
  resolveInitialTimezone,
  statusText,
  type StatusMessage,
} from "./account-section-utils";
import { AvatarSection } from "./avatar-section";

export { resolveInitialTimezone } from "./account-section-utils";

export function AccountSection() {
  const { t, locale, setLocale, pendingLocale } = useTranslations();
  const { user, isLoading, isAuthenticated, refetch } = useAuth();
  // v1.16.4 — see `useMounted`: keeps the hydration render identical to
  // the SSR HTML when this boundary hydrates after `/api/auth/me`
  // settled (React #418 family).
  const mounted = useMounted();
  const router = useRouter();
  const navigate = useCallback(
    (target: string) => router.push(target),
    [router],
  );

  const [email, setEmail] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState<string>("");
  const [timezone, setTimezone] = useState<string>("Europe/Berlin");
  // v1.7.0 — optional patient-identity fields for the health-record export.
  const [fullName, setFullName] = useState("");
  const [insurerName, setInsurerName] = useState("");
  const [insuranceNumber, setInsuranceNumber] = useState("");
  const [profileSeed, setProfileSeed] = useState({
    email: "",
    heightCm: "",
    dateOfBirth: "",
    gender: "",
    timezone: "Europe/Berlin",
    fullName: "",
    insurerName: "",
    insuranceNumber: "",
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<StatusMessage | null>(null);
  const [saveMsgType, setSaveMsgType] = useState<"success" | "error" | null>(
    null,
  );

  // Password change dialog state.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<StatusMessage | null>(null);
  const [passwordMsgType, setPasswordMsgType] = useState<
    "success" | "error" | null
  >(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);

  // v1.23 — passkey + second-factor management moved to the dedicated
  // /settings/security hub so "how I secure my account" reads as one place.

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
    const seed = {
      email: user.email ?? "",
      heightCm: user.heightCm?.toString() ?? "",
      dateOfBirth: user.dateOfBirth
        ? new Date(user.dateOfBirth).toISOString().slice(0, 10)
        : "",
      gender: user.gender ?? "",
      timezone: resolveInitialTimezone(user.timezone, detectBrowserTimezone()),
      fullName: user.fullName ?? "",
      insurerName: user.insurerName ?? "",
      insuranceNumber: user.insuranceNumber ?? "",
    };
    setSeededUserId(user.id);
    setEmail(seed.email);
    setHeightCm(seed.heightCm);
    setDateOfBirth(seed.dateOfBirth);
    setGender(seed.gender);
    setTimezone(seed.timezone);
    setFullName(seed.fullName);
    setInsurerName(seed.insurerName);
    setInsuranceNumber(seed.insuranceNumber);
    setProfileSeed(seed);
  }

  const profileDismissal = useSeededFormDismissal({
    seed: profileSeed,
    value: {
      email,
      heightCm,
      dateOfBirth,
      gender,
      timezone,
      fullName,
      insurerName,
      insuranceNumber,
    },
    blocked: saving,
    guardNavigation: true,
    navigate,
  });

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    setSaveMsgType(null);
    const savedProfile = {
      email: email.trim(),
      heightCm,
      dateOfBirth,
      gender,
      timezone,
      fullName: fullName.trim(),
      insurerName: insurerName.trim(),
      insuranceNumber: insuranceNumber.trim(),
    };

    // The timezone is owned by a dedicated route (v1.4.25 W7) so the
    // resolver cache can be invalidated without piping the flag
    // through the bigger profile patch path. Run the two PUTs in
    // parallel — they're independent.
    const [profileRes, tzRes] = await Promise.all([
      apiFetchRaw("/api/auth/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: savedProfile.email || null,
          heightCm: savedProfile.heightCm
            ? parseFloat(savedProfile.heightCm)
            : null,
          dateOfBirth: savedProfile.dateOfBirth || null,
          gender: savedProfile.gender || null,
          fullName: savedProfile.fullName || null,
          insurerName: savedProfile.insurerName || null,
          insuranceNumber: savedProfile.insuranceNumber || null,
        }),
      }),
      user && timezone && timezone !== user.timezone
        ? apiFetchRaw("/api/auth/me/timezone", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ timezone }),
          })
        : Promise.resolve({ ok: true } as Response),
    ]);

    if (profileRes.ok && tzRes.ok) {
      // Instant same-tab flip of every rendered timestamp (issue #490):
      // mirror the accepted zone before the `/me` refetch confirms it —
      // the same synchronous-update pattern the time/date-format selects
      // use. `refetch()` → `fetchMe` re-writes the mirror authoritatively.
      if (user && timezone && timezone !== user.timezone) {
        storeTimezone(timezone);
      }
      setSaveMsg({ key: "settings.profileSaved" });
      setSaveMsgType("success");
      setEmail(savedProfile.email);
      setFullName(savedProfile.fullName);
      setInsurerName(savedProfile.insurerName);
      setInsuranceNumber(savedProfile.insuranceNumber);
      setProfileSeed(savedProfile);
      await refetch();
    } else if (!tzRes.ok) {
      // The dedicated tz endpoint owns the IANA validation error
      // text. Surface its message verbatim so the user sees
      // "Not a valid IANA timezone." instead of the generic save
      // failure copy.
      try {
        const json = (await (tzRes as Response).json()) as { error?: string };
        setSaveMsg(
          json.error
            ? { text: json.error }
            : { key: "settings.timezoneInvalid" },
        );
      } catch {
        setSaveMsg({ key: "settings.timezoneInvalid" });
      }
      setSaveMsgType("error");
    } else {
      const json = await profileRes.json();
      setSaveMsg(
        json.error ? { text: json.error } : { key: "settings.savingError" },
      );
      setSaveMsgType("error");
    }
    setSaving(false);
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordSaving(true);
    setPasswordMsg(null);
    setPasswordMsgType(null);

    if (newPassword !== confirmPassword) {
      setPasswordMsg({ key: "settings.passwordMismatch" });
      setPasswordMsgType("error");
      setPasswordSaving(false);
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
        setPasswordMsg(
          json.error ? { text: json.error } : { key: "settings.savingError" },
        );
        setPasswordMsgType("error");
        return;
      }

      setPasswordMsg({ key: "settings.passwordUpdated" });
      setPasswordMsgType("success");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setPasswordMsg({ key: "common.networkError" });
      setPasswordMsgType("error");
    } finally {
      setPasswordSaving(false);
    }
  }

  if (!mounted || isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (!user) return null;

  // v1.18.6 (W9) — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` in the route; this body is the profile cards.
  return (
    <div className="space-y-6">
      {/* Profile card */}
      {/* Profile photo card */}
      <AvatarSection />

      <SettingsCard>
        <SettingsCardHeader
          icon={User}
          title={t("settings.profile")}
          className="mb-4"
        />
        <form onSubmit={handleSaveProfile} className="space-y-4 pl-7">
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
                <option value="OTHER">{t("settings.genderOther")}</option>
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
              <DateField
                id="dob"
                value={dateOfBirth}
                onChange={setDateOfBirth}
                max={new Date().toISOString().slice(0, 10)}
              />
              <p className="text-muted-foreground text-xs">
                {t("settings.dateOfBirthHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="language-select">{t("settings.language")}</Label>
              {/* While a switch waits on its message bundle (dynamic
                  import per locale), show the target value and lock the
                  control — the context only flips locale + strings
                  together once the bundle arrived. */}
              <NativeSelect
                id="language-select"
                value={pendingLocale ?? locale}
                disabled={pendingLocale !== null}
                aria-busy={pendingLocale !== null}
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

          {/* Timezone + unit system + hour format share one grid block —
              all personal display preferences (like language above). The
              unit and time-format dropdowns PATCH their own endpoints on
              change; the timezone saves through the form's submit
              handler. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <TimezonePicker value={timezone} onChange={setTimezone} />
            <UnitPreferenceSelect isAuthenticated={isAuthenticated} />
            <TimeFormatSelect isAuthenticated={isAuthenticated} />
            <DateFormatSelect isAuthenticated={isAuthenticated} />
          </div>

          {/* v1.7.0 — optional patient-identity fields surfaced on the
              health-record export cover + FHIR Patient. All optional;
              the KVNR is validated server-side and stored encrypted. */}
          <div className="border-border space-y-4 border-t pt-4">
            <p className="text-muted-foreground text-xs">
              {t("settings.identity.description")}
            </p>
            <div className="space-y-2">
              <Label htmlFor="full-name">
                {t("settings.identity.fullName")}
              </Label>
              <Input
                id="full-name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder={t("settings.identity.fullNamePlaceholder")}
                maxLength={120}
                autoComplete="name"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="insurer">
                  {t("settings.identity.insurer")}
                </Label>
                <Input
                  id="insurer"
                  value={insurerName}
                  onChange={(e) => setInsurerName(e.target.value)}
                  placeholder={t("settings.identity.insurerPlaceholder")}
                  maxLength={120}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="insurance-number">
                  {t("settings.identity.insuranceNumber")}
                </Label>
                <Input
                  id="insurance-number"
                  value={insuranceNumber}
                  onChange={(e) =>
                    setInsuranceNumber(e.target.value.toUpperCase())
                  }
                  placeholder="A123456780"
                  maxLength={10}
                  autoCapitalize="characters"
                  spellCheck={false}
                />
                <p className="text-muted-foreground text-xs">
                  {t("settings.identity.insuranceNumberHint")}
                </p>
              </div>
            </div>
          </div>

          {saveMsg && (
            <p
              role="alert"
              className={`text-sm ${
                saveMsgType === "success" ? "text-success" : "text-destructive"
              }`}
            >
              {statusText(saveMsg, t)}
            </p>
          )}

          <div className="flex justify-end">
            <Button
              type="submit"
              className="min-h-11 sm:min-h-9"
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {t("common.save")}
            </Button>
          </div>
        </form>
      </SettingsCard>

      {/* v1.18.0 (S5) — injection-site exclusions moved to the dedicated
          Medikamente settings section, where every medication-specific
          preference now lives. */}

      {/* v1.18.1 (D8) — the AI "About me" context lives under Profil, placed
          before Zyklus-Tracking. It is personal medical context (conditions,
          allergies, what the Coach should watch) the daily briefing + Coach
          read, so it belongs with the account profile rather than the AI
          provider-configuration screen. */}
      <AboutMeSection isAuthenticated={isAuthenticated} />

      {/* Cycle-tracking enable on-ramp — auto-on for female accounts, but this
          lets any account opt in (or opt out) before the gated /cycle page is
          reachable. */}
      <CycleTrackingCard isAuthenticated={isAuthenticated} />

      {/* Password card. v1.4.19 A6: action-button placement contract —
          on mobile (`<sm`) the action button stacks below the title +
          description and renders full-width; on desktop (`>=sm`) it
          right-aligns next to the title. The previous
          `flex items-center justify-between` pattern overflowed the
          card edge on Pixel 5 once button copy got longer than ~24 ch
          (the German "Passwort ändern" already pushes it; the tour
          card's "Restart onboarding tour" actually broke through the
          right border by ~48 px). */}
      <SettingsCard>
        <SettingsCardHeader
          icon={Shield}
          title={t("settings.passwordReset")}
          description={t("settings.changePasswordDescription")}
          status={
            <Button
              type="button"
              variant="outline"
              onClick={() => setPasswordDialogOpen(true)}
              className="min-h-11 w-full shrink-0 sm:min-h-9 sm:w-auto"
            >
              {t("settings.changePassword")}
            </Button>
          }
        />
      </SettingsCard>

      {/* v1.25.7 — active-session management + the security-activity feed
          live only under Settings → Data & Privacy now; the duplicate cards
          that used to sit here were removed so each surfaces in one place. */}

      {/* v1.18.1 (D1) — the "Tour neu starten" card moved to Settings →
          Erweitert. It is a maintenance / reset action, not a profile or
          security control, so it sits beside Research Mode + the danger zone. */}

      <ResponsiveSheet
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
        title={t("settings.passwordReset")}
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

          {passwordMsg && (
            <p
              role="alert"
              className={`text-sm ${
                passwordMsgType === "success"
                  ? "text-success"
                  : "text-destructive"
              }`}
            >
              {statusText(passwordMsg, t)}
            </p>
          )}

          <Button
            type="submit"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={passwordSaving}
          >
            {passwordSaving ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t("settings.changePassword")}
          </Button>
        </form>
      </ResponsiveSheet>
      <SeededFormDiscardDialog
        open={profileDismissal.discardDialogOpen}
        onConfirm={profileDismissal.confirmDiscard}
        onCancel={profileDismissal.cancelDiscard}
      />
    </div>
  );
}
