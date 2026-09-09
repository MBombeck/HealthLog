"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  BaselineFields,
  type BaselineFieldErrors,
} from "@/components/onboarding/baseline-fields";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import {
  EMPTY_HEIGHT_DRAFT,
  resolveHeightUnitAdapter,
  type HeightDraft,
} from "@/lib/profile/height-unit-display";
import { useTranslations } from "@/lib/i18n/context";
import { apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { queryKeys } from "@/lib/query-keys";
import {
  AnamnesisCard,
  buildAnamnesisAboutMeBody,
  type AnamnesisValue,
} from "@/components/onboarding/anamnesis-card";
import {
  baselineFieldLabelKeys,
  buildBaselineProfileBody,
  describeBaselineSaveOutcome,
  putBaselineProfile,
} from "@/components/onboarding/baseline-form-utils";

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
 *   1. PUT profile (empty fields are skipped). The write is
 *      field-independent, so the answer is read rather than assumed:
 *      a field the server declined is named on screen and the rest
 *      still counts as saved; a submission where nothing landed keeps
 *      the person on this step with the blocking field named. See
 *      `baseline-form-utils.ts`.
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
  /**
   * v1.32.30 — the height draft in the user's ENTRY unit (centimetres,
   * or the feet + inches pair). Converted to canonical centimetres by
   * the adapter right before the PUT; the wire stays cm.
   */
  height: HeightDraft;
  dateOfBirth: string;
  gender: string;
}

const EMPTY_FORM: BaselineFormState = {
  displayName: "",
  height: EMPTY_HEIGHT_DRAFT,
  dateOfBirth: "",
  gender: "",
};

export function BaselineForm() {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { preference } = useUnitDisplay();
  const heightAdapter = resolveHeightUnitAdapter(preference);

  const [form, setForm] = useState<BaselineFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // Refusals from the last save, one sentence per field. Cleared on
  // every attempt so a slot never keeps a reason the server no longer
  // has, and cleared per field as it is edited.
  const [fieldErrors, setFieldErrors] = useState<BaselineFieldErrors>({});

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
    // The person is answering the objection; the objection goes away
    // while they type rather than sitting under a value they already
    // corrected. `height` is the draft's name here and `heightCm` the
    // schema's — the same field, so editing either box clears it.
    const slot = key === "height" ? "heightCm" : key;
    setFieldErrors((prev) => {
      if (!(slot in prev)) return prev;
      const next = { ...prev };
      delete next[slot as keyof BaselineFieldErrors];
      return next;
    });
  }

  async function advance(opts: { saveProfile: boolean }) {
    if (saving) return;
    setSaving(true);
    setFieldErrors({});
    try {
      if (opts.saveProfile) {
        const profileBody = buildBaselineProfileBody(
          form,
          heightAdapter.toCanonicalCm(form.height),
        );
        if (Object.keys(profileBody).length > 0) {
          const outcome = describeBaselineSaveOutcome(
            await putBaselineProfile(profileBody),
            t,
            baselineFieldLabelKeys(heightAdapter.usesFeetInches),
          );
          if (outcome.notice) {
            const show =
              outcome.notice.tone === "warning" ? toast.warning : toast.error;
            show(outcome.notice.message);
          }
          if (!outcome.advance) {
            // A field was refused. Staying on the step is the point —
            // each refused input now says why under itself, the values
            // the person typed are still in front of them, and the
            // account is not stamped as set up over a value that never
            // landed.
            setFieldErrors(outcome.fieldErrors);
            setSaving(false);
            return;
          }
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
        {/* Onboarding hero H1: intentionally semibold, not the app-wide bold PageHeader H1 (UI-STANDARDS §5 hero exception). Do not sweep to font-bold. */}
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

      <BaselineFields
        value={form}
        onChange={patch}
        heightAdapter={heightAdapter}
        errors={fieldErrors}
      />

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
