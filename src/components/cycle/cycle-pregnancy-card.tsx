"use client";

import { useState } from "react";
import { Baby, Loader2 } from "lucide-react";

import { FieldGroup } from "@/components/ui/field-group";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ApiError } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";

import type { CycleProfileDTO } from "./types";
import { useUpdateCyclePrefs } from "./use-cycle";

/**
 * Pregnancy and postpartum as a cycle state, on the cycle settings
 * tab beside the profile form.
 *
 * Three choices: the ordinary cycle, pregnant (with an optional first day and
 * due date), or after a birth (with the delivery date and how many weeks the
 * state lasts). While either holds, the server pauses the period and fertility
 * forecast and every prediction reminder; this card only says so. Returning to
 * the ordinary cycle clears the dates with it.
 *
 * The form seeds from `profile` once; the parent remounts it on a refetch.
 */

type Choice = "NONE" | "PREGNANT" | "POSTPARTUM";

const KNOWN_ERRORS = new Set([
  "cycle-prefs.pregnancy.start_in_future",
  "cycle-prefs.pregnancy.delivery_in_future",
  "cycle-prefs.pregnancy.due_before_start",
  "cycle-prefs.pregnancy.delivery_required",
]);

export function CyclePregnancyCard({ profile }: { profile: CycleProfileDTO }) {
  const { t } = useTranslations();
  const update = useUpdateCyclePrefs();
  const stored = profile.pregnancy;
  const [choice, setChoice] = useState<Choice>(stored.storedState ?? "NONE");
  const [startDate, setStartDate] = useState(stored.startDate ?? "");
  const [dueDate, setDueDate] = useState(stored.dueDate ?? "");
  const [deliveryDate, setDeliveryDate] = useState(stored.deliveryDate ?? "");
  const [weeks, setWeeks] = useState(String(stored.postpartumWeeks));
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    const orNull = (v: string) => (v.trim() === "" ? null : v);
    const parsedWeeks = Number.parseInt(weeks, 10);
    try {
      await update.mutateAsync({
        pregnancy:
          choice === "NONE"
            ? { state: null }
            : choice === "PREGNANT"
              ? {
                  state: "PREGNANT",
                  startDate: orNull(startDate),
                  dueDate: orNull(dueDate),
                  deliveryDate: null,
                }
              : {
                  state: "POSTPARTUM",
                  deliveryDate: orNull(deliveryDate),
                  ...(Number.isInteger(parsedWeeks)
                    ? { postpartumWeeks: parsedWeeks }
                    : {}),
                },
      });
    } catch (err) {
      const meta = err instanceof ApiError ? err.meta : undefined;
      const code =
        typeof meta?.errorCode === "string" ? meta.errorCode : undefined;
      setError(
        code && KNOWN_ERRORS.has(code)
          ? t(`cycle.pregnancy.errors.${code.split(".").at(-1)}`)
          : t("cycle.pregnancy.errors.generic"),
      );
    }
  }

  return (
    <SettingsCard data-slot="cycle-pregnancy">
      <SettingsCardHeader
        icon={Baby}
        title={t("cycle.pregnancy.title")}
        description={t("cycle.pregnancy.description")}
      />
      <FieldGroup
        htmlFor="cycle-pregnancy-state"
        label={t("cycle.pregnancy.stateLabel")}
      >
        <NativeSelect
          id="cycle-pregnancy-state"
          value={choice}
          onChange={(e) => setChoice(e.target.value as Choice)}
        >
          <option value="NONE">{t("cycle.pregnancy.state.NONE")}</option>
          <option value="PREGNANT">
            {t("cycle.pregnancy.state.PREGNANT")}
          </option>
          <option value="POSTPARTUM">
            {t("cycle.pregnancy.state.POSTPARTUM")}
          </option>
        </NativeSelect>
      </FieldGroup>

      {choice === "PREGNANT" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldGroup
            htmlFor="cycle-pregnancy-start"
            label={t("cycle.pregnancy.startDate")}
          >
            <DateField
              id="cycle-pregnancy-start"
              value={startDate}
              onChange={setStartDate}
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="cycle-pregnancy-due"
            label={t("cycle.pregnancy.dueDate")}
          >
            <DateField
              id="cycle-pregnancy-due"
              value={dueDate}
              onChange={setDueDate}
            />
          </FieldGroup>
        </div>
      ) : null}

      {choice === "POSTPARTUM" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldGroup
            htmlFor="cycle-pregnancy-delivery"
            label={t("cycle.pregnancy.deliveryDate")}
          >
            <DateField
              id="cycle-pregnancy-delivery"
              value={deliveryDate}
              onChange={setDeliveryDate}
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="cycle-pregnancy-weeks"
            label={t("cycle.pregnancy.postpartumWeeks")}
          >
            <Input
              id="cycle-pregnancy-weeks"
              type="number"
              inputMode="numeric"
              min={1}
              max={78}
              value={weeks}
              onChange={(e) => setWeeks(e.target.value)}
            />
          </FieldGroup>
        </div>
      ) : null}

      <p className="text-sm">
        {choice === "NONE"
          ? t("cycle.pregnancy.noneHint")
          : t("cycle.pregnancy.pausedHint")}
      </p>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <SettingsCardActions>
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={update.isPending}
        >
          {update.isPending ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          ) : null}
          {t("cycle.pregnancy.save")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
