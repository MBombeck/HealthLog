"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/ui/logo";
import { Loader2 } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";

export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [heightCm, setHeightCm] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState("");
  const [saving, setSaving] = useState(false);
  const { t } = useTranslations();

  async function handleComplete(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const body: Record<string, unknown> = {};
    if (heightCm) body.heightCm = parseFloat(heightCm);
    if (dateOfBirth) body.dateOfBirth = dateOfBirth;
    if (gender) body.gender = gender;

    await fetch("/api/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await queryClient.invalidateQueries({ queryKey: ["auth"] });
    router.replace("/");
  }

  async function handleSkip() {
    setSaving(true);
    await fetch("/api/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await queryClient.invalidateQueries({ queryKey: ["auth"] });
    router.replace("/");
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-8">
      <div className="text-center">
        <Logo className="text-primary mx-auto mb-4" size={48} />
        <h1 className="text-2xl font-bold tracking-tight">
          {t("onboarding.welcome")}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {t("onboarding.setupDescription")}
        </p>
      </div>

      <form onSubmit={handleComplete} className="space-y-6">
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

        <div className="flex gap-3">
          <Button type="submit" className="flex-1" disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("onboarding.completeSetup")}
          </Button>
        </div>

        <div className="text-center">
          <button
            type="button"
            onClick={handleSkip}
            disabled={saving}
            className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4 transition-colors"
          >
            {t("onboarding.skip")}
          </button>
        </div>
      </form>
    </div>
  );
}
