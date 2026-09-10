"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  BaselineFields,
  type BaselineFieldErrors,
} from "@/components/onboarding/baseline-fields";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import {
  resolveHeightUnitAdapter,
  type HeightDraft,
} from "@/lib/profile/height-unit-display";
import { useTranslations } from "@/lib/i18n/context";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
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
 * The profile half of the confirm screen: display name, height, date of
 * birth, sex — and the optional anamnesis card.
 *
 * Values the account already holds are seeded into the fields, so a person
 * confirms them once rather than typing them again (design spec §The
 * questions: never re-ask a value the account holds). Profile fields are
 * persisted through `PUT /api/auth/profile`, the canonical write path, and
 * the answer is READ rather than assumed: a field the server declined is
 * named under its own input and the flow stays put, so the account is never
 * stamped as set up over a value that never landed (v1.38.14, iOS #97). See
 * `baseline-form-utils.ts` for the outcome logic.
 *
 * Submit flow on "Confirm and continue":
 *   1. PUT profile (untouched fields are left out). A refusal stops here.
 *   2. PUT /api/coach/about-me — only when the anamnesis card was filled;
 *      preserves any existing `aboutMe` and writes conditions / allergies
 *      encrypted at rest.
 *   3. `onConfirmed()` — the confirm screen's own completion, which derives
 *      the module map and moves on.
 *
 * "Skip" runs step 3 alone: the flow still completes, the profile can be
 * filled later from Settings.
 */

export interface BaselineInitialValues {
  heightCm: number | null;
  dateOfBirth: string | null;
  gender: string | null;
}

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

export function BaselineForm({
  initial,
  backHref,
  onConfirmed,
  confirming = false,
}: {
  initial: BaselineInitialValues;
  backHref?: string;
  /** The confirm screen's completion; awaited after a clean save. */
  onConfirmed: () => Promise<void>;
  /** True while the completion the parent owns is in flight. */
  confirming?: boolean;
}) {
  const { t } = useTranslations();
  const { preference } = useUnitDisplay();
  const heightAdapter = resolveHeightUnitAdapter(preference);

  const [form, setForm] = useState<BaselineFormState>(() => ({
    displayName: "",
    height: heightAdapter.toDraft(initial.heightCm),
    // The payload's ISO instant, as the date field's YYYY-MM-DD.
    dateOfBirth: initial.dateOfBirth ? initial.dateOfBirth.slice(0, 10) : "",
    gender: initial.gender ?? "",
  }));
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
    if (saving || confirming) return;
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
      await onConfirmed();
    } catch (err) {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="onboarding-baseline-title" className="space-y-6">
      <header className="space-y-1">
        {/* A section of the confirm screen, which owns the page's h1. */}
        <h2 id="onboarding-baseline-title" className="text-base font-semibold">
          {t("onboarding.baseline.title")}
        </h2>
        <p className="text-muted-foreground text-sm">
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

      <div
        className="flex items-center justify-between gap-2 pt-2"
        data-slot="onboarding-step-actions"
      >
        {backHref ? (
          <Button asChild variant="ghost" className="min-h-11 min-w-11">
            <Link href={backHref} data-slot="onboarding-back">
              {t("onboarding.shell.back")}
            </Link>
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => advance({ saveProfile: false })}
            disabled={saving || confirming}
            className="min-h-11 min-w-11"
            data-slot="onboarding-skip"
          >
            {t("onboarding.shell.skip")}
          </Button>
          <Button
            type="button"
            onClick={() => advance({ saveProfile: true })}
            disabled={saving || confirming}
            className="min-h-11 min-w-11"
            data-slot="onboarding-next"
          >
            {saving || confirming ? (
              <Loader2
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
            ) : null}
            {t("onboarding.flow.confirm.cta")}
          </Button>
        </div>
      </div>
    </section>
  );
}
