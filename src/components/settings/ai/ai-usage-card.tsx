"use client";

/* ────────────────────────────────────────────────────────────────
 * v1.43 (#1217) — AI usage: one setting, three levels.
 *
 * The level decides how much background AI work the account asks for: how
 * often status cards regenerate after a sync, the snapshot size, background
 * reasoning, the length of the daily briefing, the automatic document read
 * and the label photo. The Coach is the same at every level.
 *
 * Everything shown comes off `ai.usage` on `/api/auth/me`, resolved on the
 * server: which options the operator allows, the estimate per option (only
 * ever labelled as one), the measured use. The card computes nothing. A pick
 * is written at once through `PUT /api/auth/me/ai-usage`; the account payload
 * is refetched so every surface that reads a capability sees the new level.
 * ──────────────────────────────────────────────────────────────── */

import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";

import { Button } from "@/components/ui/button";
import { rovingRadioNextIndex } from "@/hooks/use-roving-radio-group";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useAiProviderState, useAiUsage } from "@/hooks/use-ai-capability";
import { apiPut } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import type { AiUsageLevel, AiUsageState } from "@/lib/ai/usage-level";
import { useTranslations } from "@/lib/i18n/context";
import { aiInputDependentKeys, invalidateKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

const LEVEL_KEYS = {
  frugal: {
    label: "settings.ai.usage.levels.frugal.label",
    hint: "settings.ai.usage.levels.frugal.hint",
  },
  standard: {
    label: "settings.ai.usage.levels.standard.label",
    hint: "settings.ai.usage.levels.standard.hint",
  },
  full: {
    label: "settings.ai.usage.levels.full.label",
    hint: "settings.ai.usage.levels.full.hint",
  },
} as const satisfies Record<AiUsageLevel, { label: string; hint: string }>;

export function AiUsageCard() {
  const { t, locale } = useTranslations();
  const queryClient = useQueryClient();
  const usage = useAiUsage();
  const provider = useAiProviderState();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const save = useMutation<AiUsageState, Error, AiUsageLevel | null>({
    mutationFn: (level) =>
      apiPut<AiUsageState>("/api/auth/me/ai-usage", { level }),
    onSuccess: () => {
      void invalidateKeys(queryClient, aiInputDependentKeys);
    },
    // The toast carries the error id a 5xx needs for a support report.
    onError: (error) =>
      showErrorToast(t("settings.ai.usage.saveError"), { cause: error }),
  });

  // An older server publishes no level: there is nothing to set.
  if (!usage) return null;

  // Only the account itself sets its level, and only while the operator's
  // master switch is on (`canConfigure` is false inside somebody else's
  // record and while AI is off on the server).
  const editable = provider.canConfigure && !save.isPending;
  const tokens = (value: number) => new Intl.NumberFormat(locale).format(value);
  const levelName = (level: AiUsageLevel) => t(LEVEL_KEYS[level].label);
  // Whether the history suffices for an estimate is the server's call: it
  // publishes the per-level estimates only once it does. The card reads that
  // decision instead of repeating its day threshold.
  const estimatesReady = usage.options.some(
    (option) => option.estimatedTokensPerDay !== null,
  );
  const allowedLevels = usage.options
    .filter((option) => option.allowed)
    .map((option) => option.level);

  function pick(level: AiUsageLevel) {
    if (!editable || level === usage?.level) return;
    save.mutate(level);
  }

  function onKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    level: AiUsageLevel,
  ) {
    const from = allowedLevels.indexOf(level);
    const next = rovingRadioNextIndex(event.key, from, allowedLevels.length);
    if (next === null) return;
    event.preventDefault();
    const target = allowedLevels[next]!;
    pick(target);
    refs.current[usage!.options.findIndex((o) => o.level === target)]?.focus();
  }

  return (
    <SettingsCard data-slot="ai-usage-card">
      <SettingsCardHeader
        anchor="ai-usage"
        icon={Gauge}
        title={t("settings.ai.usage.title")}
        description={t("settings.ai.usage.description")}
      />

      <div
        role="radiogroup"
        aria-label={t("settings.ai.usage.title")}
        aria-disabled={!editable || undefined}
        className="border-border divide-border divide-y rounded-lg border"
      >
        {usage.options.map((option, i) => {
          const checked = option.level === usage.level;
          const disabled = !option.allowed || !editable;
          return (
            <button
              key={option.level}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-disabled={disabled || undefined}
              tabIndex={checked ? 0 : -1}
              data-slot="ai-usage-option"
              data-level={option.level}
              data-allowed={option.allowed}
              onClick={() => (option.allowed ? pick(option.level) : undefined)}
              onKeyDown={(event) => onKeyDown(event, option.level)}
              className={cn(
                "flex min-h-11 w-full items-start gap-3 px-3 py-2.5 text-left first:rounded-t-lg last:rounded-b-lg",
                "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                checked && "bg-primary/10",
                !option.allowed && "cursor-not-allowed opacity-50",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "border-border mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  checked && "border-primary",
                )}
              >
                {checked ? (
                  <span className="bg-primary size-2 rounded-full" />
                ) : null}
              </span>
              {/* Stacked under 640 px so the estimate never squeezes the
                  level's name and hint into a sliver; side by side above. */}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {levelName(option.level)}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {t(LEVEL_KEYS[option.level].hint)}
                  </span>
                  {!option.allowed ? (
                    <span
                      data-slot="ai-usage-limited"
                      className="text-muted-foreground block text-xs"
                    >
                      {t("settings.ai.usage.limited")}
                    </span>
                  ) : null}
                </span>
                <span
                  data-slot="ai-usage-estimate"
                  className="text-muted-foreground text-xs tabular-nums sm:max-w-[45%] sm:shrink-0 sm:text-right"
                >
                  {option.estimatedTokensPerDay === null
                    ? null
                    : t("settings.ai.usage.estimate", {
                        tokens: tokens(option.estimatedTokensPerDay),
                      })}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <p
        data-slot="ai-usage-measured"
        className="text-muted-foreground text-xs"
      >
        {usage.measuredTokensPerDay === null || !estimatesReady
          ? t("settings.ai.usage.noEstimate")
          : t("settings.ai.usage.measured", {
              tokens: tokens(usage.measuredTokensPerDay),
              days: usage.measuredDays,
            })}
      </p>

      {usage.source === "admin_cap" && usage.preference ? (
        <p data-slot="ai-usage-capped" className="text-sm">
          {t("settings.ai.usage.capped", {
            choice: levelName(usage.preference),
            level: levelName(usage.level),
          })}
        </p>
      ) : usage.source === "default" ? (
        <p
          data-slot="ai-usage-default"
          className="text-muted-foreground text-xs"
        >
          {t("settings.ai.usage.followsDefault", {
            level: levelName(usage.defaultLevel),
          })}
        </p>
      ) : null}

      {usage.preference !== null ? (
        <SettingsCardActions>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!editable}
            onClick={() => save.mutate(null)}
            data-slot="ai-usage-use-default"
          >
            {t("settings.ai.usage.useDefault", {
              level: levelName(usage.defaultLevel),
            })}
          </Button>
        </SettingsCardActions>
      ) : null}
    </SettingsCard>
  );
}
