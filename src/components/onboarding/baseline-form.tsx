"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslations } from "@/lib/i18n/context";
import { apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { queryKeys } from "@/lib/query-keys";
import {
  AnamnesisCard,
  buildAnamnesisAboutMeBody,
  type AnamnesisValue,
} from "@/components/onboarding/anamnesis-card";

/**
 * v1.4.25 W14b-Content — onboarding step 3 (baseline).
 *
 * Captures the four profile fields the original v1.4.20 wizard
 * collected on its "About you" screen — display name, height, date of
 * birth, gender — but spread across a single mobile-friendly card
 * instead of the older grid layout. The legacy `/api/onboarding/complete`
 * endpoint is *not* used here: completion now flips on the new
 * `POST /api/onboarding/step` with `{ step: 4 }`. Profile fields are
 * persisted via `PUT /api/auth/profile`, the existing canonical write
 * path (see `applyProfileUpdate` in `src/lib/auth/profile-update.ts`).
 *
 * Submit flow on "Save and continue":
 *   1. PUT profile (best-effort — empty fields are skipped).
 *   2. PUT /api/coach/about-me — only when the optional anamnesis card
 *      (v1.17.1) was filled; preserves any existing `aboutMe` and
 *      writes conditions / allergies encrypted at rest.
 *   3. POST step:4 — flips `onboardingCompletedAt` server-side and
 *      clears the proxy cookie.
 *   4. router.push("/onboarding/4") — the done screen.
 *
 * "Skip" advances without writing profile data; the wizard still
 * completes onboarding (the user can fill profile later from
 * Settings).
 */

interface BaselineFormState {
  displayName: string;
  heightCm: string;
  dateOfBirth: string;
  gender: string;
}

const EMPTY_FORM: BaselineFormState = {
  displayName: "",
  heightCm: "",
  dateOfBirth: "",
  gender: "",
};

export function BaselineForm() {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<BaselineFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // v1.17.1 — optional anamnesis (conditions + allergies). Persisted
  // through the existing encrypted self-context path
  // (`PUT /api/coach/about-me`). We read the current self-context once
  // so a returning/resuming user's free-text `aboutMe` is preserved on
  // save (the PUT schema requires `aboutMe`, and an empty value clears
  // it). A fresh user has no self-context, so `baseAboutMe` stays "".
  const [anamnesis, setAnamnesis] = useState<AnamnesisValue>({
    conditions: "",
    allergies: "",
  });
  const [baseAboutMe, setBaseAboutMe] = useState("");

  useEffect(() => {
    let active = true;
    void apiGet<{ aboutMe: string | null }>("/api/coach/about-me")
      .then((ctx) => {
        if (active && typeof ctx.aboutMe === "string") {
          setBaseAboutMe(ctx.aboutMe);
        }
      })
      .catch(() => {
        // Non-fatal — onboarding must never block on the self-context
        // read. A fresh user has none; on error we keep the "" base,
        // which the PUT below only sends when the user actually typed
        // an anamnesis answer.
      });
    return () => {
      active = false;
    };
  }, []);

  function patch<K extends keyof BaselineFormState>(
    key: K,
    value: BaselineFormState[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function advance(opts: { saveProfile: boolean }) {
    if (saving) return;
    setSaving(true);
    try {
      if (opts.saveProfile) {
        const profileBody: Record<string, unknown> = {};
        if (form.displayName.trim())
          profileBody.displayName = form.displayName.trim();
        if (form.heightCm) {
          const n = Number.parseFloat(form.heightCm);
          if (Number.isFinite(n)) profileBody.heightCm = n;
        }
        if (form.dateOfBirth) profileBody.dateOfBirth = form.dateOfBirth;
        if (form.gender === "MALE" || form.gender === "FEMALE") {
          profileBody.gender = form.gender;
        }
        if (Object.keys(profileBody).length > 0) {
          await apiPut("/api/auth/profile", profileBody);
        }

        // Anamnesis — only write when the user actually filled a field
        // (the helper returns null for an untouched card, so a
        // collapsed card never round-trips).
        const aboutMeBody = buildAnamnesisAboutMeBody(baseAboutMe, anamnesis);
        if (aboutMeBody) {
          await apiPut("/api/coach/about-me", aboutMeBody);
        }
      }
      await apiPost("/api/onboarding/step", { step: 4 });
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
      router.push("/onboarding/4");
    } catch (err) {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="onboarding-baseline-title" className="space-y-6">
      <header className="space-y-2">
        <h1
          id="onboarding-baseline-title"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight"
        >
          {t("onboarding.baseline.title")}
        </h1>
        <p className="text-muted-foreground text-base leading-relaxed">
          {t("onboarding.baseline.body")}
        </p>
      </header>

      <fieldset className="bg-card border-border space-y-4 rounded-xl border p-4 md:p-6">
        <legend className="sr-only">{t("onboarding.baseline.title")}</legend>

        <FieldGroup
          htmlFor="ob-baseline-display-name"
          label={t("onboarding.baseline.displayNameLabel")}
          hint={t("onboarding.baseline.displayNameHint")}
        >
          <Input
            id="ob-baseline-display-name"
            value={form.displayName}
            onChange={(e) => patch("displayName", e.target.value)}
            autoComplete="nickname"
            maxLength={50}
            placeholder={t("onboarding.baseline.displayNamePlaceholder")}
          />
        </FieldGroup>

        <div className="grid gap-4 sm:grid-cols-2">
          <FieldGroup
            htmlFor="ob-baseline-height"
            label={t("onboarding.baseline.heightLabel")}
          >
            <Input
              id="ob-baseline-height"
              type="number"
              inputMode="decimal"
              value={form.heightCm}
              onChange={(e) => patch("heightCm", e.target.value)}
              placeholder="175"
              min={50}
              max={300}
              step={0.1}
              autoComplete="off"
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="ob-baseline-gender"
            label={t("onboarding.baseline.genderLabel")}
          >
            <Select
              // The design system's Radix Select uses an empty-string
              // sentinel to mean "no selection"; map back and forth so
              // the form state ("") and the Select's value (undefined-
              // adjacent) stay aligned. v1.4.25 W21 Fix-N (design-M1).
              value={form.gender === "" ? undefined : form.gender}
              onValueChange={(next) => patch("gender", next)}
            >
              <SelectTrigger
                id="ob-baseline-gender"
                className="w-full"
                data-slot="onboarding-baseline-gender"
              >
                <SelectValue
                  placeholder={t("onboarding.baseline.genderNone")}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MALE">
                  {t("onboarding.baseline.genderMale")}
                </SelectItem>
                <SelectItem value="FEMALE">
                  {t("onboarding.baseline.genderFemale")}
                </SelectItem>
              </SelectContent>
            </Select>
          </FieldGroup>
        </div>

        <FieldGroup
          htmlFor="ob-baseline-dob"
          label={t("onboarding.baseline.dateOfBirthLabel")}
          hint={t("onboarding.baseline.dateOfBirthHint")}
        >
          <DateField
            id="ob-baseline-dob"
            value={form.dateOfBirth}
            onChange={(value) => patch("dateOfBirth", value)}
            max={new Date().toISOString().slice(0, 10)}
            autoComplete="bday"
          />
        </FieldGroup>
      </fieldset>

      <AnamnesisCard
        value={anamnesis}
        onChange={setAnamnesis}
        disabled={saving}
      />

      <div className="flex items-center justify-between gap-2 pt-2">
        <Button asChild variant="ghost" className="min-h-11 min-w-11">
          <Link href="/onboarding/2">{t("onboarding.shell.back")}</Link>
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => advance({ saveProfile: false })}
            disabled={saving}
            className="min-h-11 min-w-11"
          >
            {t("onboarding.shell.skip")}
          </Button>
          <Button
            type="button"
            onClick={() => advance({ saveProfile: true })}
            disabled={saving}
            className="min-h-11 min-w-11"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("onboarding.baseline.saveCta")}
          </Button>
        </div>
      </div>
    </section>
  );
}
