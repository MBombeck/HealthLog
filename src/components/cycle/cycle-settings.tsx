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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
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
        <div className="space-y-2">
          <Label htmlFor="cycle-goal">{t("cycle.goal.label")}</Label>
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
        </div>

        <Separator />

        {/* Predictions — when the goal hides conception framing, the
            description never names a fertile window. */}
        <ToggleRow
          id="cycle-prediction"
          label={t("cycle.settings.prediction")}
          description={t("cycle.settings.predictionDescription")}
          checked={predictionEnabled}
          onChange={setPredictionEnabled}
        />
        <ToggleRow
          id="cycle-rawchart"
          label={t("cycle.settings.rawChartMode")}
          description={t("cycle.settings.rawChartModeDescription")}
          checked={rawChartMode}
          onChange={setRawChartMode}
        />

        <Separator />

        {/* Priors */}
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
        <div className="space-y-2">
          <Label htmlFor="cycle-secondary-symptom">
            {t("cycle.settings.secondarySymptomLabel")}
          </Label>
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
          <p className="text-muted-foreground text-sm">
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
          </p>
        </div>

        <Separator />

        {/* Privacy toggles */}
        <ToggleRow
          id="cycle-encryption"
          label={t("cycle.settings.encryption")}
          description={t("cycle.settings.encryptionDescription")}
          checked={encryption}
          onChange={setEncryption}
        />
        <ToggleRow
          id="cycle-discreet"
          label={t("cycle.settings.discreet")}
          description={t("cycle.settings.discreetDescription")}
          checked={discreet}
          onChange={setDiscreet}
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

        <div className="flex items-center justify-end gap-3 pt-2">
          {update.isSuccess ? (
            <span className="text-muted-foreground text-sm" role="status">
              {t("cycle.settings.saved")}
            </span>
          ) : null}
          {update.isError ? (
            <span className="text-destructive text-sm" role="alert">
              {t("cycle.settings.saveError")}
            </span>
          ) : null}
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("cycle.settings.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

/**
 * A "label + description → go to notifications" row. The long fertile-window
 * label collided with its button when both shared one tight flex line; here the
 * row stacks on the narrowest screens (button on its own line, full-width tap
 * target) and reflows to a clean inline layout from `sm` up, where the text
 * column can wrap freely while the button stays top-aligned and never shrinks.
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
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        asChild
        className="min-h-11 w-full shrink-0 sm:min-h-9 sm:w-auto"
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
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-input bg-background focus-visible:border-input-focus w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none"
      />
    </div>
  );
}
