"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import {
  SeededFormDiscardDialog,
  useSeededFormDismissal,
} from "@/components/forms/use-seeded-form-dismissal";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { HeightFieldControl } from "@/components/profile/height-field-control";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import {
  EMPTY_HEIGHT_DRAFT,
  resolveHeightUnitAdapter,
  type HeightDraft,
} from "@/lib/profile/height-unit-display";
import { locales, localeLabels, type Locale } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { TimezonePicker } from "@/components/settings/timezone-picker";
import { storeTimezone } from "@/lib/timezone-mirror";
import { TimeFormatSelect } from "@/components/settings/time-format-select";
import { DateFormatSelect } from "@/components/settings/date-format-select";
import { UnitPreferenceSelect } from "@/components/settings/unit-preference-select";
import { GlucoseUnitSelect } from "@/components/settings/glucose-unit-select";
import { detectBrowserTimezone } from "@/lib/tz/format";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import {
  describeRejectedProfileField,
  describeRejectedProfileFields,
  type RejectedProfileField,
} from "@/lib/profile/rejected-fields";
import { FieldError } from "@/components/forms/field-error";
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
  // v1.32.30 — height follows the metric/imperial preference like every
  // other value the app shows. Storage stays canonical centimetres; the
  // adapter owns both directions of the conversion.
  const { preference } = useUnitDisplay();
  const heightAdapter = resolveHeightUnitAdapter(preference);
  const router = useRouter();
  const navigate = useCallback(
    (target: string) => router.push(target),
    [router],
  );

  const [email, setEmail] = useState("");
  const [height, setHeight] = useState<HeightDraft>(EMPTY_HEIGHT_DRAFT);
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState<string>("");
  const [timezone, setTimezone] = useState<string>("Europe/Berlin");
  // v1.7.0 — optional patient-identity fields for the health-record export.
  const [fullName, setFullName] = useState("");
  const [insurerName, setInsurerName] = useState("");
  const [insuranceNumber, setInsuranceNumber] = useState("");
  const [profileSeed, setProfileSeed] = useState({
    email: "",
    height: EMPTY_HEIGHT_DRAFT,
    dateOfBirth: "",
    gender: "",
    timezone: "Europe/Berlin",
    fullName: "",
    insurerName: "",
    insuranceNumber: "",
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<StatusMessage | null>(null);
  const [saveMsgType, setSaveMsgType] = useState<
    "success" | "warning" | "error" | null
  >(null);
  // One sentence per field the last save refused, keyed by the schema
  // name the server sent. The banner above the button says a save was
  // partial; these say which value was not stored and why, under the
  // input holding it. Cleared at the start of every save.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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
      height: heightAdapter.toDraft(user.heightCm),
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
    setHeight(seed.height);
    setDateOfBirth(seed.dateOfBirth);
    setGender(seed.gender);
    setTimezone(seed.timezone);
    setFullName(seed.fullName);
    setInsurerName(seed.insurerName);
    setInsuranceNumber(seed.insuranceNumber);
    setProfileSeed(seed);
  }

  // The unit select sits on this very card, so the preference can flip
  // while the form is open. Re-express the height draft through the new
  // branch (round-tripped via canonical centimetres) instead of
  // stranding an empty field; every other slot keeps its in-flight edit.
  // Functional updaters so this composes with the seed block above when
  // both run in the same render.
  const [seededPreference, setSeededPreference] = useState(preference);
  if (preference !== seededPreference) {
    const previous = resolveHeightUnitAdapter(seededPreference);
    setSeededPreference(preference);
    setHeight((prev) => heightAdapter.toDraft(previous.toCanonicalCm(prev)));
    setProfileSeed((prev) => ({
      ...prev,
      height: heightAdapter.toDraft(previous.toCanonicalCm(prev.height)),
    }));
  }

  const profileDismissal = useSeededFormDismissal({
    seed: profileSeed,
    value: {
      email,
      height,
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
    setFieldErrors({});
    const savedProfile = {
      email: email.trim(),
      height,
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
          heightCm: heightAdapter.toCanonicalCm(savedProfile.height),
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
      const profileJson = (await profileRes.json().catch(() => null)) as {
        data?: { rejectedFields?: RejectedProfileField[] };
      } | null;
      const rejected = profileJson?.data?.rejectedFields;

      if (rejected && rejected.length > 0) {
        // The write is field-independent: everything but the rejected
        // field(s) landed. Name the field instead of implying full
        // success, and reseed the form from what the server actually
        // persisted — the client's optimistic value for the rejected
        // field was never written, so it must not read as saved.
        setSaveMsg({
          key: "settings.profilePartiallySaved",
          params: { field: describeRejectedProfileField(rejected, t) ?? "" },
        });
        setSaveMsgType("warning");
        setFieldErrors(describeRejectedProfileFields(rejected, t));
        await refetch();
        setSeededUserId(null);
      } else {
        setSaveMsg({ key: "settings.profileSaved" });
        setSaveMsgType("success");
        setEmail(savedProfile.email);
        setFullName(savedProfile.fullName);
        setInsurerName(savedProfile.insurerName);
        setInsuranceNumber(savedProfile.insuranceNumber);
        setProfileSeed(savedProfile);
        await refetch();
      }
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
      // The server's top-level `error` string is intentionally generic
      // (never a raw validator message); resolve the specific, localized
      // reason through `meta.errorCode` instead of echoing it verbatim.
      const json = (await profileRes.json().catch(() => null)) as {
        meta?: { errorCode?: string };
        details?: { issues?: RejectedProfileField[] };
      } | null;
      const errorCode = json?.meta?.errorCode;
      const field = describeRejectedProfileField(json?.details?.issues, t);
      setFieldErrors(describeRejectedProfileFields(json?.details?.issues, t));
      if (errorCode === "profile.update.nothingSaved" && field) {
        setSaveMsg({ key: "settings.profileNothingSaved", params: { field } });
      } else if (errorCode) {
        setSaveMsg({ key: `apiErrors.${errorCode}` });
      } else {
        setSaveMsg({ key: "settings.savingError" });
      }
      setSaveMsgType("error");
    }
    setSaving(false);
  }

  if (!mounted || isLoading) {
    // §13 — a loading section paints its card + header, not a bare centered
    // spinner (reference: admin/coach-feedback-section).
    return (
      <SettingsCard>
        <SettingsCardHeader icon={User} title={t("settings.profile")} />
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          <span className="text-muted-foreground text-sm">
            {t("common.loading")}
          </span>
        </div>
      </SettingsCard>
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
        <SettingsCardHeader icon={User} title={t("settings.profile")} />
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
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={fieldErrors.email ? "email-error" : undefined}
              />
              <FieldError id="email-error" message={fieldErrors.email} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="gender">{t("settings.gender")}</Label>
              <NativeSelect
                id="gender"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                aria-invalid={fieldErrors.gender ? true : undefined}
                aria-describedby={
                  fieldErrors.gender ? "gender-error" : undefined
                }
              >
                <option value="">{t("settings.genderNone")}</option>
                <option value="MALE">{t("settings.genderMale")}</option>
                <option value="FEMALE">{t("settings.genderFemale")}</option>
                <option value="OTHER">{t("settings.genderOther")}</option>
              </NativeSelect>
              <p className="text-muted-foreground text-xs">
                {t("settings.genderHint")}
              </p>
              <FieldError id="gender-error" message={fieldErrors.gender} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="height">
                {heightAdapter.usesFeetInches
                  ? t("settings.heightFtIn")
                  : t("settings.height")}
              </Label>
              <HeightFieldControl
                idPrefix="height"
                adapter={heightAdapter}
                value={height}
                onChange={setHeight}
                enterKeyHint="next"
                invalid={Boolean(fieldErrors.heightCm)}
                describedBy={fieldErrors.heightCm ? "height-error" : undefined}
              />
              <FieldError id="height-error" message={fieldErrors.heightCm} />
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
                aria-invalid={fieldErrors.dateOfBirth ? true : undefined}
                aria-describedby={
                  fieldErrors.dateOfBirth ? "dob-error" : undefined
                }
              />
              <p className="text-muted-foreground text-xs">
                {t("settings.dateOfBirthHint")}
              </p>
              <FieldError id="dob-error" message={fieldErrors.dateOfBirth} />
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

          {/* Timezone, unit system, glucose unit and the date/hour formats
              share one grid block — all personal display preferences (like
              language above). The glucose unit is its own dropdown rather
              than a branch of the unit system because metric countries are
              split on which unit they read glucose in. Every dropdown here
              PATCHes its own endpoint on change; the timezone saves through
              the form's submit handler. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <TimezonePicker value={timezone} onChange={setTimezone} />
            <UnitPreferenceSelect isAuthenticated={isAuthenticated} />
            <GlucoseUnitSelect isAuthenticated={isAuthenticated} />
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
                aria-invalid={fieldErrors.fullName ? true : undefined}
                aria-describedby={
                  fieldErrors.fullName ? "full-name-error" : undefined
                }
              />
              <FieldError id="full-name-error" message={fieldErrors.fullName} />
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
                  aria-invalid={fieldErrors.insurerName ? true : undefined}
                  aria-describedby={
                    fieldErrors.insurerName ? "insurer-error" : undefined
                  }
                />
                <FieldError
                  id="insurer-error"
                  message={fieldErrors.insurerName}
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
                  aria-invalid={fieldErrors.insuranceNumber ? true : undefined}
                  aria-describedby={
                    fieldErrors.insuranceNumber
                      ? "insurance-number-error"
                      : undefined
                  }
                />
                <p className="text-muted-foreground text-xs">
                  {t("settings.identity.insuranceNumberHint")}
                </p>
                <FieldError
                  id="insurance-number-error"
                  message={fieldErrors.insuranceNumber}
                />
              </div>
            </div>
          </div>

          {saveMsg && (
            <p
              role="alert"
              className={`text-sm ${
                saveMsgType === "success"
                  ? "text-success"
                  : saveMsgType === "warning"
                    ? "text-warning"
                    : "text-destructive"
              }`}
            >
              {statusText(saveMsg, t)}
            </p>
          )}

          <SettingsCardActions>
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
          </SettingsCardActions>
        </form>
      </SettingsCard>

      {/* v1.18.0 (S5) — injection-site exclusions moved to the dedicated
          Medikamente settings section, where every medication-specific
          preference now lives. */}

      {/* #159 — the AI "About me" note and the free-text allergies line moved
          to Settings → Anamnese: they are personal medical context, so they
          sit with conditions, allergies and family history as one medical
          history (`anamnesis-section.tsx`). */}

      {/* Cycle tracking is a module, and the Modules hub carries its switch.
          The second enable surface that used to sit here asked the same
          question in a second place. */}

      {/* Changing the password is a security control, so the card lives in
          Settings → Security beside the second factors and the passkeys. */}

      {/* v1.25.7 — active-session management + the security-activity feed
          live only under Settings → Data & Privacy now; the duplicate cards
          that used to sit here were removed so each surfaces in one place. */}

      {/* v1.18.1 (D1) — the "Tour neu starten" card moved to Settings →
          Erweitert. It is a maintenance / reset action, not a profile or
          security control, so it sits beside Research Mode + the danger zone. */}

      <SeededFormDiscardDialog
        open={profileDismissal.discardDialogOpen}
        onConfirm={profileDismissal.confirmDiscard}
        onCancel={profileDismissal.cancelDiscard}
      />
    </div>
  );
}
