"use client";

import { useId, useState } from "react";
import { ChevronDown, HeartHandshake } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.17.1 — optional "About your health" card on the onboarding
 * Baseline step (3).
 *
 * Captures the genuinely-new baseline the app can act on — chronic
 * conditions and allergies / intolerances — that the height/sex/dob
 * fields above do NOT already cover. Both write through the existing
 * encrypted self-context path (`PUT /api/coach/about-me`), so there is
 * no new model and no new contract; the parent BaselineForm preserves
 * any existing free-text `aboutMe` on save.
 *
 * Collapsed by default with a prominent skip framing — the step stays
 * übersichtlich and every field is optional and editable later in
 * Settings → AI. Warm, medically-grounded copy: framed as "so
 * HealthLog reads your numbers in context," never as a clinical form.
 *
 * Controlled: the parent owns the values so it can persist them in the
 * same submit as the profile fields.
 */
export interface AnamnesisValue {
  conditions: string;
  allergies: string;
}

/**
 * Build the `PUT /api/coach/about-me` body for the anamnesis answers,
 * or `null` when the card was left untouched (so an untouched collapsed
 * card never round-trips). Preserves the existing free-text `aboutMe`
 * (the PUT schema requires it and an empty value clears it) and only
 * includes conditions / allergies when the user typed something — so an
 * unrelated stored value is never cleared. Field-by-field assembly: no
 * mass-spread of the value object into the body.
 */
export function buildAnamnesisAboutMeBody(
  baseAboutMe: string,
  value: AnamnesisValue,
): Record<string, unknown> | null {
  const conditions = value.conditions.trim();
  const allergies = value.allergies.trim();
  if (!conditions && !allergies) return null;
  const body: Record<string, unknown> = { aboutMe: baseAboutMe };
  if (conditions) body.conditions = conditions;
  if (allergies) body.allergies = allergies;
  return body;
}

export interface AnamnesisCardProps {
  value: AnamnesisValue;
  onChange: (next: AnamnesisValue) => void;
  disabled?: boolean;
  /**
   * v1.39 — the instance cannot persist what is typed here, so nothing may
   * be typed. True under `DEMO_MODE`: the demo is one published account
   * every visitor signs into, and `PUT /api/coach/about-me` is off the
   * demo's edge allowlist because this text persists for the next visitor
   * and is fed into the Coach prompt. The card still shows what it asks —
   * the demo walks the same screen — it just does not take an answer, which
   * is honest where a refused save on Confirm would not be.
   */
  readOnly?: boolean;
}

/** Per-field cap mirrors ABOUT_ME_FIELD_MAX_CHARS on the server. */
const FIELD_MAX = 500;

export function AnamnesisCard({
  value,
  onChange,
  disabled,
  readOnly = false,
}: AnamnesisCardProps) {
  const { t } = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const conditionsId = useId();
  const allergiesId = useId();
  const panelId = useId();

  return (
    <div
      className="bg-card border-border rounded-xl border"
      data-slot="onboarding-anamnesis"
      data-readonly={readOnly ? "true" : undefined}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 rounded-xl p-4 text-left md:p-6"
      >
        <span
          aria-hidden="true"
          className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full"
        >
          <HeartHandshake className="size-4" />
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="text-foreground block text-sm font-medium">
            {t("onboarding.anamnesis.title")}
          </span>
          <span className="text-muted-foreground block text-xs leading-relaxed">
            {t("onboarding.anamnesis.subtitle")}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        <div id={panelId} className="space-y-4 px-4 pb-4 md:px-6 md:pb-6">
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("onboarding.anamnesis.intro")}
          </p>

          <div className="space-y-2">
            <Label htmlFor={conditionsId}>
              {t("onboarding.anamnesis.conditionsLabel")}
            </Label>
            <Textarea
              id={conditionsId}
              value={value.conditions}
              onChange={(e) =>
                onChange({ ...value, conditions: e.target.value })
              }
              disabled={disabled || readOnly}
              maxLength={FIELD_MAX}
              rows={2}
              placeholder={t("onboarding.anamnesis.conditionsPlaceholder")}
            />
            <p className="text-muted-foreground text-xs">
              {t("onboarding.anamnesis.conditionsHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={allergiesId}>
              {t("onboarding.anamnesis.allergiesLabel")}
            </Label>
            <Textarea
              id={allergiesId}
              value={value.allergies}
              onChange={(e) =>
                onChange({ ...value, allergies: e.target.value })
              }
              disabled={disabled || readOnly}
              maxLength={FIELD_MAX}
              rows={2}
              placeholder={t("onboarding.anamnesis.allergiesPlaceholder")}
            />
          </div>

          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("onboarding.anamnesis.privacyNote")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
