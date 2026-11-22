"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field-group";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { SwitchRow } from "@/components/ui/switch-row";
import { useTranslations } from "@/lib/i18n/context";
import type { CycleGoal, CycleProfileDTO, SecondarySymptom } from "./types";
import { useUpdateCyclePrefs } from "./use-cycle";

/**
 * v1.15.0 — the single-page cycle settings form.
 *
 * One dynamic form, no top/bottom split (the project's settings-UX rule):
 * the inclusive goal selector drives all copy — fertile-window language only
 * appears for TRYING_TO_CONCEIVE; GENERAL_HEALTH / PERIMENOPAUSE / OFF hide
 * conception framing. Priors, raw-chart mode, sensitive-category encryption,
 * discreet notifications, and the data export/delete affordances all live on
 * the one page. PATCHes `/api/auth/me/cycle-prefs`.
 *
 * The form seeds its local state from `profile` once on mount; the parent
 * passes `key={profile.updatedAt}` so a profile refetch remounts the form
 * with the fresh values rather than syncing through an effect.
 */

const GOALS: CycleGoal[] = [
  "GENERAL_HEALTH",
  "AVOID_PREGNANCY",
  "TRYING_TO_CONCEIVE",
  "PERIMENOPAUSE",
  "OFF",
];

const SECONDARY_SYMPTOMS: SecondarySymptom[] = ["MUCUS", "CERVIX"];

function numOrEmpty(v: number | null): string {
  return v == null ? "" : String(v);
}

export function CycleSettings({ profile }: { profile: CycleProfileDTO }) {
  const { t } = useTranslations();
  const update = useUpdateCyclePrefs();

  const [goal, setGoal] = useState<CycleGoal>(profile.goal);
  const [rawChartMode, setRawChartMode] = useState(profile.rawChartMode);
  const [predictionEnabled, setPredictionEnabled] = useState(
    profile.predictionEnabled,
  );
  const [encryption, setEncryption] = useState(
    profile.sensitiveCategoryEncryption,
  );
  const [discreet, setDiscreet] = useState(profile.discreetNotifications);
  const [secondarySymptom, setSecondarySymptom] = useState<SecondarySymptom>(
    profile.secondarySymptom,
  );
  const [cycleLen, setCycleLen] = useState(
    numOrEmpty(profile.typicalCycleLength),
  );
  const [periodLen, setPeriodLen] = useState(
    numOrEmpty(profile.typicalPeriodLength),
  );
  const [lutealLen, setLutealLen] = useState(
    numOrEmpty(profile.lutealPhaseLength),
  );

  function parsePrior(v: string): number | null {
    const n = Number(v);
    return v.trim() === "" || !Number.isFinite(n) ? null : Math.round(n);
  }

  async function handleSave() {
    await update.mutateAsync({
      goal,
      secondarySymptom,
      rawChartMode,
      predictionEnabled,
      sensitiveCategoryEncryption: encryption,
      discreetNotifications: discreet,
      typicalCycleLength: parsePrior(cycleLen),
      typicalPeriodLength: parsePrior(periodLen),
      lutealPhaseLength: parsePrior(lutealLen),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("cycle.settings.title")}</CardTitle>
        <CardDescription>{t("cycle.goal.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Inclusive goal selector — drives the rest of the copy. */}
        <FieldGroup htmlFor="cycle-goal" label={t("cycle.goal.label")}>
          <NativeSelect
            id="cycle-goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value as CycleGoal)}
          >
            {GOALS.map((g) => (
              <option key={g} value={g}>
                {t(`cycle.goal.${g}`)}
              </option>
            ))}
          </NativeSelect>
        </FieldGroup>

        <Separator />

        {/* Predictions — when the goal hides conception framing, the
            description never names a fertile window. */}
        <SwitchRow
          id="cycle-prediction"
          label={t("cycle.settings.prediction")}
          description={t("cycle.settings.predictionDescription")}
          checked={predictionEnabled}
          onCheckedChange={setPredictionEnabled}
        />
        <SwitchRow
          id="cycle-rawchart"
          label={t("cycle.settings.rawChartMode")}
          description={t("cycle.settings.rawChartModeDescription")}
          checked={rawChartMode}
          onCheckedChange={setRawChartMode}
        />

        <Separator />

        <div className="space-y-3">
          <p className="text-sm font-medium">
            {t("cycle.settings.priorsDescription")}
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <PriorField
              id="cycle-typical-length"
              label={t("cycle.settings.typicalCycleLength")}
              value={cycleLen}
              onChange={setCycleLen}
              min={15}
              max={60}
            />
            <PriorField
              id="cycle-period-length"
              label={t("cycle.settings.typicalPeriodLength")}
              value={periodLen}
              onChange={setPeriodLen}
              min={1}
              max={15}
            />
            <PriorField
              id="cycle-luteal-length"
              label={t("cycle.settings.lutealPhaseLength")}
              value={lutealLen}
              onChange={setLutealLen}
              min={10}
              max={16}
            />
          </div>
        </div>

        <Separator />

        {/* Advanced — symptothermal secondary symptom. The default is mucus;
            the choice never forces itself on a casual user (progressive
            disclosure: it sits here in the advanced cycle settings). */}
        <FieldGroup
          htmlFor="cycle-secondary-symptom"
          label={t("cycle.settings.secondarySymptomLabel")}
          hint={
            <>
              {t("cycle.settings.secondarySymptomDescription")}{" "}
              {/* Primary source for the symptothermal double-check method: the
                  German NFP prospective cohort (Frank-Herrmann et al., Human
                  Reproduction 2007). Plain anchor — no markdown renderer. */}
              <a
                href="https://pubmed.ncbi.nlm.nih.gov/17314078/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground/80 hover:text-foreground underline underline-offset-2"
              >
                {t("cycle.settings.secondarySymptomCitation")}
              </a>
            </>
          }
        >
          <NativeSelect
            id="cycle-secondary-symptom"
            value={secondarySymptom}
            onChange={(e) =>
              setSecondarySymptom(e.target.value as SecondarySymptom)
            }
          >
            {SECONDARY_SYMPTOMS.map((s) => (
              <option key={s} value={s}>
                {t(`cycle.settings.secondarySymptom.${s}`)}
              </option>
            ))}
          </NativeSelect>
        </FieldGroup>

        <Separator />

        {/* Privacy toggles */}
        <SwitchRow
          id="cycle-encryption"
          label={t("cycle.settings.encryption")}
          description={t("cycle.settings.encryptionDescription")}
          checked={encryption}
          onCheckedChange={setEncryption}
        />
        <SwitchRow
          id="cycle-discreet"
          label={t("cycle.settings.discreet")}
          description={t("cycle.settings.discreetDescription")}
          checked={discreet}
          onCheckedChange={setDiscreet}
        />

        <Separator />

        {/* Reminders — the per-channel toggles live on the notifications page;
            point users there rather than duplicating the toggle state here. */}
        <LinkRow
          title={t("cycle.settings.reminders")}
          description={t("cycle.settings.remindersDescription")}
          linkLabel={t("cycle.settings.remindersLink")}
        />

        {/* Fertile-window reminder — surfaced ONLY under the conception goal.
            The toggle itself is the default-OFF per-channel CYCLE_FERTILE_SOON
            switch on the notifications page; here we just point a TTC user to
            it, so the affordance never appears (and fertile language never
            shows) for the other goals (the inclusive-framing rule). */}
        {goal === "TRYING_TO_CONCEIVE" ? (
          <LinkRow
            title={t("cycle.settings.fertileReminder")}
            description={t("cycle.settings.fertileReminderDescription")}
            linkLabel={t("cycle.settings.remindersLink")}
          />
        ) : null}

        {/* Cycle data export + delete live with the main Settings → Export and
            Account surfaces (cycle rows ride the full-backup export and the
            account-level delete), so the standalone affordances are not
            duplicated here. */}

        {update.isSuccess ? (
          <p className="text-muted-foreground text-right text-sm" role="status">
            {t("cycle.settings.saved")}
          </p>
        ) : null}
        {update.isError ? (
          <p className="text-destructive text-right text-sm" role="alert">
            {t("cycle.settings.saveError")}
          </p>
        ) : null}
        <SettingsCardActions>
          <Button size="sm" onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("cycle.settings.save")}
          </Button>
        </SettingsCardActions>
      </CardContent>
    </Card>
  );
}

/**
 * A "label + description → go to notifications" row: the text wraps in its
 * own column and the action stays beside it (UI standards §11).
 */
function LinkRow({
  title,
  description,
  linkLabel,
}: {
  title: string;
  description: string;
  linkLabel: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        asChild
        className="min-h-11 shrink-0 sm:min-h-9"
      >
        <Link href="/notifications">{linkLabel}</Link>
      </Button>
    </div>
  );
}

function PriorField({
  id,
  label,
  value,
  onChange,
  min,
  max,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
}) {
  return (
    <FieldGroup htmlFor={id} label={label}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-input bg-background focus-visible:border-input-focus w-full rounded-md border px-3 py-2 text-base focus-visible:outline-none md:pointer-fine:text-sm"
      />
    </FieldGroup>
  );
}
