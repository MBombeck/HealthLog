"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/ui/logo";
import { Loader2, ChevronRight } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const TOTAL_STEPS = 4;

export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslations();

  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);

  // Step 1: Profile
  const [heightCm, setHeightCm] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState("");

  // Step 2: Medications
  const [medName, setMedName] = useState("");
  const [medDose, setMedDose] = useState("");
  const [meds, setMeds] = useState<Array<{ name: string; dose: string }>>([]);

  // Step 3: Targets
  const [targetSys, setTargetSys] = useState("");
  const [targetDia, setTargetDia] = useState("");
  const [targetWeight, setTargetWeight] = useState("");

  async function finishOnboarding() {
    setSaving(true);

    try {
      const body: Record<string, unknown> = {};
      if (heightCm) body.heightCm = parseFloat(heightCm);
      if (dateOfBirth) body.dateOfBirth = dateOfBirth;
      if (gender) body.gender = gender;

      const profileRes = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!profileRes.ok) {
        throw new Error(t("onboarding.errorProfile"));
      }

      // Create medications. Server validation requires at least one schedule,
      // so we attach a sensible default — the user is informed via medScheduleHint
      // and can refine it in Medications later. Phase 3.5 of the audit replaces
      // this entire wizard with an empty-state-driven flow.
      for (const med of meds) {
        const medRes = await fetch("/api/medications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: med.name,
            dose: med.dose,
            schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
          }),
        });
        if (!medRes.ok) {
          throw new Error(t("onboarding.errorMedication", { name: med.name }));
        }
      }

      if (targetSys || targetDia || targetWeight) {
        const targets: Record<string, unknown> = {};
        if (targetSys) targets.bpSysTarget = parseInt(targetSys);
        if (targetDia) targets.bpDiaTarget = parseInt(targetDia);
        if (targetWeight) targets.weightTarget = parseFloat(targetWeight);
        const targetsRes = await fetch("/api/insights/targets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(targets),
        });
        if (!targetsRes.ok) {
          throw new Error(t("onboarding.errorTargets"));
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      router.replace("/");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("onboarding.errorGeneric");
      toast.error(message);
      setSaving(false);
    }
  }

  function addMedication() {
    if (!medName.trim()) return;
    setMeds([...meds, { name: medName.trim(), dose: medDose.trim() }]);
    setMedName("");
    setMedDose("");
  }

  function nextStep() {
    if (step < TOTAL_STEPS) {
      setStep(step + 1);
    } else {
      finishOnboarding();
    }
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-6">
      <div className="text-center">
        <Logo className="text-primary mx-auto mb-4" size={48} />
        <h1 className="text-2xl font-bold tracking-tight">
          {t("onboarding.welcome")}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {t("onboarding.setupDescription")}
        </p>
      </div>

      {/* Progress indicator */}
      <div className="flex justify-center gap-2">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div
            key={i}
            className={cn(
              "h-1.5 w-8 rounded-full transition-colors",
              i + 1 <= step ? "bg-primary" : "bg-muted",
            )}
          />
        ))}
      </div>

      {/* Step 1: Profile */}
      {step === 1 && (
        <div className="bg-card border-border space-y-4 rounded-xl border p-6">
          <h2 className="text-lg font-semibold">{t("settings.profile")}</h2>
          <div className="space-y-2">
            <Label htmlFor="ob-height">{t("settings.height")}</Label>
            <Input
              id="ob-height"
              type="number"
              value={heightCm}
              onChange={(e) => setHeightCm(e.target.value)}
              placeholder="175"
              min={50}
              max={300}
              step={0.1}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ob-gender">{t("settings.gender")}</Label>
            <select
              id="ob-gender"
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:ring-[3px] focus-visible:outline-none"
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
            <Label htmlFor="ob-dob">{t("settings.dateOfBirth")}</Label>
            <Input
              id="ob-dob"
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
            />
            <p className="text-muted-foreground text-xs">
              {t("settings.dateOfBirthHint")}
            </p>
          </div>
        </div>
      )}

      {/* Step 2: Medications */}
      {step === 2 && (
        <div className="bg-card border-border space-y-4 rounded-xl border p-6">
          <h2 className="text-lg font-semibold">
            {t("onboarding.medicationsTitle")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("onboarding.medicationsDescription")}
          </p>
          <div className="flex gap-2">
            <Input
              value={medName}
              onChange={(e) => setMedName(e.target.value)}
              placeholder={t("onboarding.medNamePlaceholder")}
              className="flex-1"
            />
            <Input
              value={medDose}
              onChange={(e) => setMedDose(e.target.value)}
              placeholder={t("onboarding.medDosePlaceholder")}
              className="w-24"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addMedication}
            >
              +
            </Button>
          </div>
          {meds.length > 0 && (
            <>
              <ul className="space-y-1 text-sm">
                {meds.map((m, i) => (
                  <li
                    key={i}
                    className="bg-muted/50 flex items-center justify-between rounded px-3 py-1.5"
                  >
                    <span>
                      {m.name} {m.dose && `(${m.dose})`}
                    </span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive text-xs"
                      onClick={() => setMeds(meds.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground text-xs">
                {t("onboarding.medScheduleHint")}
              </p>
            </>
          )}
        </div>
      )}

      {/* Step 3: Notifications teaser */}
      {step === 3 && (
        <div className="bg-card border-border space-y-4 rounded-xl border p-6">
          <h2 className="text-lg font-semibold">
            {t("onboarding.notificationsTitle")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("onboarding.notificationsDescription")}
          </p>
          <div className="bg-muted/50 space-y-2 rounded-lg p-4 text-sm">
            <p>
              📱 <strong>Telegram</strong> — {t("onboarding.telegramHint")}
            </p>
            <p>
              🔔 <strong>Web Push</strong> — {t("onboarding.webPushHint")}
            </p>
          </div>
          <p className="text-muted-foreground text-xs">
            {t("onboarding.notificationsLater")}
          </p>
        </div>
      )}

      {/* Step 4: Targets */}
      {step === 4 && (
        <div className="bg-card border-border space-y-4 rounded-xl border p-6">
          <h2 className="text-lg font-semibold">
            {t("onboarding.targetsTitle")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("onboarding.targetsDescription")}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ob-sys">{t("onboarding.targetSys")}</Label>
              <Input
                id="ob-sys"
                type="number"
                value={targetSys}
                onChange={(e) => setTargetSys(e.target.value)}
                placeholder="130"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ob-dia">{t("onboarding.targetDia")}</Label>
              <Input
                id="ob-dia"
                type="number"
                value={targetDia}
                onChange={(e) => setTargetDia(e.target.value)}
                placeholder="85"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ob-weight">{t("onboarding.targetWeight")}</Label>
            <Input
              id="ob-weight"
              type="number"
              value={targetWeight}
              onChange={(e) => setTargetWeight(e.target.value)}
              placeholder="75"
              step={0.1}
            />
          </div>
        </div>
      )}

      {/* Navigation buttons */}
      <div className="flex gap-3">
        <Button onClick={nextStep} className="flex-1" disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {step < TOTAL_STEPS ? (
            <>
              {t("common.next")}
              <ChevronRight className="ml-1 h-4 w-4" />
            </>
          ) : (
            t("onboarding.completeSetup")
          )}
        </Button>
      </div>

      <div className="text-center">
        {step < TOTAL_STEPS ? (
          <button
            type="button"
            onClick={nextStep}
            disabled={saving}
            className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4 transition-colors"
          >
            {t("onboarding.skip")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              // Skip targets and finish
              finishOnboarding();
            }}
            disabled={saving}
            className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4 transition-colors"
          >
            {t("onboarding.skip")}
          </button>
        )}
      </div>
    </div>
  );
}
