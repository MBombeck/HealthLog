"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  CheckCircle2,
  Loader2,
  MessageCircle,
  Smartphone,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/ui/logo";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { useTranslations } from "@/lib/i18n/context";
import { locales, localeLabels, type Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

const TOTAL_STEPS = 3;

type ChannelChoice = "TELEGRAM" | "WEB_PUSH" | "NTFY" | "NONE";

const CHANNEL_OPTIONS: ReadonlyArray<{
  id: ChannelChoice;
  Icon: typeof MessageCircle;
  titleKey: string;
  hintKey: string;
  /**
   * Hash anchor on the notifications settings page to scroll to. NONE = skip,
   * no hash. The wizard pushes the user to `/settings/notifications#<hash>`
   * after onboarding finishes — see the v1.4 settings split (PR A2-shell)
   * for the new route shape.
   */
  hash: string | null;
}> = [
  {
    id: "TELEGRAM",
    Icon: MessageCircle,
    titleKey: "onboarding.v2.step3.channelTelegramTitle",
    hintKey: "onboarding.v2.step3.channelTelegramHint",
    hash: "telegram",
  },
  {
    id: "WEB_PUSH",
    Icon: Bell,
    titleKey: "onboarding.v2.step3.channelWebPushTitle",
    hintKey: "onboarding.v2.step3.channelWebPushHint",
    hash: "web-push",
  },
  {
    id: "NTFY",
    Icon: Smartphone,
    titleKey: "onboarding.v2.step3.channelNtfyTitle",
    hintKey: "onboarding.v2.step3.channelNtfyHint",
    hash: "ntfy",
  },
  {
    id: "NONE",
    Icon: CheckCircle2,
    titleKey: "onboarding.v2.step3.channelNoneTitle",
    hintKey: "onboarding.v2.step3.channelNoneHint",
    hash: null,
  },
];

export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t, locale, setLocale } = useTranslations();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [saving, setSaving] = useState(false);

  // Step 1 — about you
  const [displayName, setDisplayName] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState("");

  // Step 2 — first measurement is captured by `<MeasurementForm>`
  // directly; we just track whether the user has already submitted one
  // so the UI can switch to a "got it" state.
  const [measurementLogged, setMeasurementLogged] = useState(false);

  // Step 3 — preferred notification channel.
  const [channelChoice, setChannelChoice] = useState<ChannelChoice>("NONE");

  function goBack() {
    setStep((prev) => (prev > 1 ? ((prev - 1) as 1 | 2) : 1));
  }

  /**
   * Persist the profile + complete onboarding. Always called once at
   * the end of the wizard — independent of which steps were skipped —
   * so `onboardingCompletedAt` is set even if the user skips
   * everything except the wizard click-through.
   */
  async function persistAndExit(opts?: { gotoSettingsHash?: string | null }) {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (displayName.trim()) body.displayName = displayName.trim();
      if (heightCm) body.heightCm = parseFloat(heightCm);
      if (dateOfBirth) body.dateOfBirth = dateOfBirth;
      if (gender) body.gender = gender;

      const res = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(t("onboarding.errorProfile"));

      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      toast.success(t("onboarding.v2.doneToast"));

      if (opts?.gotoSettingsHash) {
        router.replace(`/settings/notifications#${opts.gotoSettingsHash}`);
      } else {
        router.replace("/");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("onboarding.errorGeneric");
      toast.error(message);
      setSaving(false);
    }
  }

  function nextStep() {
    if (step < TOTAL_STEPS) {
      setStep((step + 1) as 1 | 2 | 3);
    }
  }

  function finish() {
    const target =
      channelChoice !== "NONE"
        ? (CHANNEL_OPTIONS.find((c) => c.id === channelChoice)?.hash ?? null)
        : null;
    void persistAndExit({ gotoSettingsHash: target });
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-6 py-6">
      <div className="text-center">
        <Logo className="text-primary mx-auto mb-4" size={48} />
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("onboarding.v2.title")}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {t("onboarding.v2.subtitle")}
        </p>
      </div>

      {/* Progress indicator — labelled for screen readers */}
      <div
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={TOTAL_STEPS}
        aria-valuenow={step}
        aria-label={t("onboarding.v2.stepOf", {
          current: step,
          total: TOTAL_STEPS,
        })}
        className="flex items-center justify-center gap-2"
      >
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div
            key={i}
            className={cn(
              "h-1.5 w-10 rounded-full transition-colors duration-150 ease-out motion-reduce:transition-none",
              i + 1 <= step ? "bg-primary" : "bg-muted",
            )}
          />
        ))}
      </div>
      <p className="text-muted-foreground -mt-3 text-center text-xs">
        {t("onboarding.v2.stepOf", { current: step, total: TOTAL_STEPS })}
      </p>

      {/* ───── Step 1 — about you ───── */}
      {step === 1 && (
        <section
          aria-labelledby="ob-step1-title"
          className="bg-card border-border space-y-5 rounded-xl border p-6"
        >
          <header className="space-y-1">
            <h2
              id="ob-step1-title"
              className="text-lg font-semibold tracking-tight"
            >
              {t("onboarding.v2.step1.title")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("onboarding.v2.step1.description")}
            </p>
          </header>

          <div className="space-y-2">
            <Label htmlFor="ob-display-name">
              {t("onboarding.v2.step1.displayNameLabel")}
            </Label>
            <Input
              id="ob-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
              placeholder={t("settings.username")}
              maxLength={50}
            />
            <p className="text-muted-foreground text-xs">
              {t("onboarding.v2.step1.displayNameHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ob-language">
              {t("onboarding.v2.step1.languageLabel")}
            </Label>
            <select
              id="ob-language"
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
              className="border-input bg-background text-foreground ring-offset-background focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:ring-[3px] focus-visible:outline-none"
            >
              {locales.map((loc) => (
                <option key={loc} value={loc}>
                  {localeLabels[loc as Locale]}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">
              {t("onboarding.v2.step1.languageHint")}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ob-height">{t("settings.height")}</Label>
              <Input
                id="ob-height"
                type="number"
                inputMode="decimal"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                placeholder="175"
                min={50}
                max={300}
                step={0.1}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ob-gender">{t("settings.gender")}</Label>
              <select
                id="ob-gender"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="border-input bg-background text-foreground ring-offset-background focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:ring-[3px] focus-visible:outline-none"
              >
                <option value="">{t("settings.genderNone")}</option>
                <option value="MALE">{t("settings.genderMale")}</option>
                <option value="FEMALE">{t("settings.genderFemale")}</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ob-dob">{t("settings.dateOfBirth")}</Label>
            <Input
              id="ob-dob"
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              autoComplete="bday"
            />
            <p className="text-muted-foreground text-xs">
              {t("settings.dateOfBirthHint")}
            </p>
          </div>
        </section>
      )}

      {/* ───── Step 2 — first measurement ───── */}
      {step === 2 && (
        <section
          aria-labelledby="ob-step2-title"
          className="bg-card border-border space-y-5 rounded-xl border p-6"
        >
          <header className="space-y-1">
            <h2
              id="ob-step2-title"
              className="text-lg font-semibold tracking-tight"
            >
              {t("onboarding.v2.step2.title")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("onboarding.v2.step2.description")}
            </p>
          </header>

          {measurementLogged ? (
            <div className="border-primary/40 bg-primary/5 text-foreground flex items-start gap-3 rounded-lg border p-4 text-sm">
              <CheckCircle2 className="text-primary mt-0.5 size-5 shrink-0" />
              <p>{t("onboarding.v2.step2.added")}</p>
            </div>
          ) : (
            <MeasurementForm onSuccess={() => setMeasurementLogged(true)} />
          )}

          <p className="text-muted-foreground text-xs">
            {t("onboarding.v2.step2.skipHint")}
          </p>
        </section>
      )}

      {/* ───── Step 3 — pick a channel ───── */}
      {step === 3 && (
        <section
          aria-labelledby="ob-step3-title"
          className="bg-card border-border space-y-5 rounded-xl border p-6"
        >
          <header className="space-y-1">
            <h2
              id="ob-step3-title"
              className="text-lg font-semibold tracking-tight"
            >
              {t("onboarding.v2.step3.title")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("onboarding.v2.step3.description")}
            </p>
          </header>

          <fieldset className="space-y-2">
            <legend className="sr-only">
              {t("onboarding.v2.step3.title")}
            </legend>
            {CHANNEL_OPTIONS.map((option) => {
              const checked = channelChoice === option.id;
              const Icon = option.Icon;
              return (
                <label
                  key={option.id}
                  className={cn(
                    "border-border hover:border-primary/50 flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors duration-150 ease-out motion-reduce:transition-none",
                    checked && "border-primary bg-primary/5",
                  )}
                >
                  <input
                    type="radio"
                    name="ob-channel"
                    value={option.id}
                    checked={checked}
                    onChange={() => setChannelChoice(option.id)}
                    className="text-primary focus-visible:ring-ring mt-1 size-4 focus-visible:ring-[3px] focus-visible:outline-none"
                  />
                  <span className="flex min-w-0 flex-1 items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md"
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {t(option.titleKey)}
                      </span>
                      <span className="text-muted-foreground block text-xs">
                        {t(option.hintKey)}
                      </span>
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        </section>
      )}

      {/* ───── Navigation row ───── */}
      <div className="flex items-center gap-3">
        {step > 1 ? (
          <Button
            type="button"
            variant="outline"
            onClick={goBack}
            disabled={saving}
          >
            <ArrowLeft className="mr-1 size-4" />
            {t("onboarding.v2.back")}
          </Button>
        ) : (
          <span className="flex-1" />
        )}

        {step < TOTAL_STEPS ? (
          <Button
            type="button"
            onClick={nextStep}
            className="ml-auto"
            disabled={saving}
          >
            {t("onboarding.v2.continue")}
            <ArrowRight className="ml-1 size-4" />
          </Button>
        ) : (
          <Button
            type="button"
            onClick={finish}
            className="ml-auto"
            disabled={saving}
          >
            {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
            {channelChoice === "NONE"
              ? t("onboarding.v2.finish")
              : t("onboarding.v2.step3.openSettings")}
          </Button>
        )}
      </div>

      {/* Single Skip per step. Step 3's "NONE" choice already covers
          skipping notifications, so we hide the underline on step 3. */}
      {step < TOTAL_STEPS ? (
        <button
          type="button"
          onClick={nextStep}
          disabled={saving}
          className="text-muted-foreground hover:text-foreground mx-auto block text-sm underline-offset-4 transition-colors duration-150 ease-out hover:underline motion-reduce:transition-none"
        >
          {t("onboarding.v2.skipStep")}
        </button>
      ) : null}
    </div>
  );
}
