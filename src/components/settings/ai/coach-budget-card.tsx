"use client";

/* ────────────────────────────────────────────────────────────────
 * The Coach budget of a self-hosted model: snapshot size, tokens, rounds and
 * seconds per turn, set separately for the Local provider and for the
 * OpenAI-compatible gateway. Empty fields keep the built-in values, which are
 * the placeholders. The server refuses a value outside the bounds and clamps
 * whatever is stored again when a turn reads it (`coach-budgets.ts`).
 * ──────────────────────────────────────────────────────────────── */

import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Gauge, Loader2, Save } from "lucide-react";

import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  COACH_BUDGET_BOUNDS,
  COACH_BUDGET_DEFAULTS,
  type CoachBudget,
  type CoachBudgetField,
} from "@/lib/ai/coach/coach-budgets";
import { apiPatch } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import { aiInputDependentKeys, invalidateKeys } from "@/lib/query-keys";

import type { UserAIProvider } from "./shared";

type BudgetProvider = "local" | "compat";

const FIELDS: readonly CoachBudgetField[] = [
  "snapshotChars",
  "turnTokens",
  "maxRounds",
  "turnSeconds",
];

const FIELD_LABEL_KEYS: Record<CoachBudgetField, string> = {
  snapshotChars: "settings.ai.coachBudgetSnapshotChars",
  turnTokens: "settings.ai.coachBudgetTurnTokens",
  maxRounds: "settings.ai.coachBudgetMaxRounds",
  turnSeconds: "settings.ai.coachBudgetTurnSeconds",
};

type Draft = Record<CoachBudgetField, string>;

function draftOf(budget: CoachBudget | null | undefined): Draft {
  const out = {} as Draft;
  for (const name of FIELDS) {
    out[name] = budget?.[name] != null ? String(budget[name]) : "";
  }
  return out;
}

/** The body field for one draft, or null when a value is out of range. */
export function budgetFromDraft(
  draft: Draft,
): Record<CoachBudgetField, number | null> | null {
  const out = {} as Record<CoachBudgetField, number | null>;
  for (const name of FIELDS) {
    const raw = draft[name].trim();
    if (raw === "") {
      out[name] = null;
      continue;
    }
    const value = Number(raw);
    const { min, max } = COACH_BUDGET_BOUNDS[name];
    if (!Number.isInteger(value) || value < min || value > max) return null;
    out[name] = value;
  }
  return out;
}

export function CoachBudgetCard({
  userProvider,
}: {
  userProvider: UserAIProvider | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<BudgetProvider>(
    userProvider?.provider?.toUpperCase() === "OPENAI_COMPATIBLE"
      ? "compat"
      : "local",
  );
  const [drafts, setDrafts] = useState<Record<BudgetProvider, Draft>>({
    local: draftOf(null),
    compat: draftOf(null),
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const submitInFlightRef = useRef(false);

  // Seed from the persisted budgets once they arrive (seed-on-data pattern).
  const seededKey =
    userProvider != null
      ? JSON.stringify([
          userProvider.localCoachBudget ?? null,
          userProvider.compatCoachBudget ?? null,
        ])
      : null;
  const [previousSeed, setPreviousSeed] = useState<string | null>(null);
  if (seededKey != null && seededKey !== previousSeed) {
    setPreviousSeed(seededKey);
    setDrafts({
      local: draftOf(userProvider?.localCoachBudget),
      compat: draftOf(userProvider?.compatCoachBudget),
    });
  }

  const saveMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      await apiPatch("/api/user/ai-provider", body);
    },
    onSuccess: () => {
      setOk(true);
      setMsg(t("settings.ai.saved"));
      void invalidateKeys(queryClient, aiInputDependentKeys);
    },
    onError: (e) => {
      setOk(false);
      setMsg(localizedApiError(e, t, "settings.ai.errorGeneric"));
    },
    onSettled: () => {
      submitInFlightRef.current = false;
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitInFlightRef.current || saveMutation.isPending) return;
    const budget = budgetFromDraft(drafts[provider]);
    if (budget === null) {
      setOk(false);
      setMsg(t("settings.ai.coachBudgetInvalid"));
      return;
    }
    submitInFlightRef.current = true;
    saveMutation.mutate({
      [provider === "local" ? "localCoachBudget" : "compatCoachBudget"]: budget,
    });
  }

  const draft = drafts[provider];
  return (
    <SettingsCard as="form" onSubmit={submit} noValidate>
      <SettingsCardHeader
        anchor="coach-budget"
        icon={Gauge}
        title={t("settings.ai.coachBudgetHeading")}
      />
      <p className="text-muted-foreground text-xs">
        {t("settings.ai.coachBudgetBody")}
      </p>
      <Segmented
        label={t("settings.ai.coachBudgetProvider")}
        value={provider}
        onChange={(next) => {
          setProvider(next);
          setMsg(null);
        }}
        options={[
          { value: "local", label: t("settings.ai.coachBudgetLocal") },
          { value: "compat", label: t("settings.ai.coachBudgetCompat") },
        ]}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((name) => {
          const id = `coach-budget-${provider}-${name}`;
          const { min, max } = COACH_BUDGET_BOUNDS[name];
          return (
            <div key={name} className="flex flex-col gap-1.5">
              <Label htmlFor={id}>{t(FIELD_LABEL_KEYS[name])}</Label>
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                value={draft[name]}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [provider]: { ...prev[provider], [name]: e.target.value },
                  }))
                }
                placeholder={String(COACH_BUDGET_DEFAULTS[name])}
                aria-describedby={`${id}-hint`}
              />
              <p id={`${id}-hint`} className="text-muted-foreground text-xs">
                {t("settings.ai.coachBudgetRange", { min, max })}
              </p>
            </div>
          );
        })}
      </div>
      {msg && (
        <WrittenOutcomeLine
          outcome={ok ? "success" : "failed"}
          message={msg}
          testId="coach-budget-outcome"
        />
      )}
      <SettingsCardActions>
        <Button
          type="submit"
          size="sm"
          className="min-h-11 sm:min-h-9"
          aria-busy={saveMutation.isPending || undefined}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {t("settings.ai.saveCta")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
