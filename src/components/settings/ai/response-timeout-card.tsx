"use client";

/* ────────────────────────────────────────────────────────────────
 * v1.22 (#89) — Response timeout (seconds).
 *
 * A per-user upstream timeout for every model call on the record: the
 * resolver binds it to the provider and each client reads its ceiling through
 * `callTimeoutMs` (only the nudge tick and the reaction line keep their own
 * short ceilings). Surfaced here mainly for local / self-hosted backends: an
 * MLX/exo server can take >60 s on the first request while it loads the model.
 * Empty = each surface's own default (60 s for most, longer for the briefing).
 * ──────────────────────────────────────────────────────────────── */

import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, Timer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { PROVIDER_DEFAULT_TIMEOUT_MS } from "@/lib/ai/effective-timeout";
import { apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { aiInputDependentKeys, invalidateKeys } from "@/lib/query-keys";

import type { UserAIProvider } from "./shared";

/**
 * The defaults the copy names, read from the constants the server applies, so
 * the placeholder cannot drift from the real fallback again (it said "~120"
 * while most surfaces waited 60 s).
 */
export const RESPONSE_TIMEOUT_COPY_PARAMS = {
  seconds: PROVIDER_DEFAULT_TIMEOUT_MS / 1000,
  briefingSeconds: (AI_BUDGETS.comprehensive.timeoutMs ?? 0) / 1000,
} as const;

export function ResponseTimeoutCard({
  userProvider,
}: {
  userProvider: UserAIProvider | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const submitInFlightRef = useRef(false);

  // Seed from the persisted value once it arrives (seed-on-data pattern).
  const seededKey =
    userProvider != null
      ? `${userProvider.responseTimeoutSeconds ?? ""}`
      : null;
  const [previousSeed, setPreviousSeed] = useState<string | null>(null);
  if (seededKey != null && seededKey !== previousSeed) {
    setPreviousSeed(seededKey);
    setValue(
      userProvider?.responseTimeoutSeconds != null
        ? String(userProvider.responseTimeoutSeconds)
        : "",
    );
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const trimmed = value.trim();
      const responseTimeoutSeconds = trimmed === "" ? null : Number(trimmed);
      if (
        responseTimeoutSeconds !== null &&
        (!Number.isInteger(responseTimeoutSeconds) ||
          responseTimeoutSeconds < 10 ||
          responseTimeoutSeconds > 600)
      ) {
        throw new Error(t("settings.ai.responseTimeoutInvalid"));
      }
      await apiPatch("/api/user/ai-provider", { responseTimeoutSeconds });
    },
    onSuccess: () => {
      setOk(true);
      setMsg(t("settings.ai.saved"));
      void invalidateKeys(queryClient, aiInputDependentKeys);
    },
    onError: (e) => {
      setOk(false);
      setMsg(e instanceof Error ? e.message : t("settings.ai.errorGeneric"));
    },
    onSettled: () => {
      submitInFlightRef.current = false;
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitInFlightRef.current || saveMutation.isPending) return;
    submitInFlightRef.current = true;
    saveMutation.mutate();
  }

  return (
    <SettingsCard as="form" onSubmit={submit} noValidate>
      <SettingsCardHeader
        icon={Timer}
        title={t("settings.ai.responseTimeoutHeading")}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-response-timeout">
          {t("settings.ai.responseTimeoutLabel")}
        </Label>
        <Input
          id="ai-response-timeout"
          type="number"
          inputMode="numeric"
          min={10}
          max={600}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t(
            "settings.ai.responseTimeoutPlaceholder",
            RESPONSE_TIMEOUT_COPY_PARAMS,
          )}
          aria-describedby="ai-response-timeout-hint"
          className="sm:max-w-xs"
        />
        {/* The explainer is several sentences, so it rides under the field it
            explains rather than in the one-sentence header slot. */}
        <p
          id="ai-response-timeout-hint"
          className="text-muted-foreground text-xs"
        >
          {t("settings.ai.responseTimeoutBody", RESPONSE_TIMEOUT_COPY_PARAMS)}
        </p>
      </div>
      {msg && (
        <p className={`text-xs ${ok ? "text-success" : "text-destructive"}`}>
          {msg}
        </p>
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
