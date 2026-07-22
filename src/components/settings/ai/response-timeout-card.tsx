"use client";

/* ────────────────────────────────────────────────────────────────
 * v1.22 (#89) — Response timeout (seconds).
 *
 * A per-user upstream timeout for AI generation, threaded onto the provider
 * call (`CompletionParams.timeoutMs`). Surfaced here mainly for local /
 * self-hosted backends: an MLX/exo server can take >60 s on the first request
 * while it loads the model, which the legacy 60 s default timed out before the
 * first token landed. Empty = the built-in comprehensive-briefing default
 * (~120 s, `AI_BUDGETS.comprehensive.timeoutMs`).
 * ──────────────────────────────────────────────────────────────── */

import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import type { UserAIProvider } from "./shared";

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
      queryClient.invalidateQueries({ queryKey: queryKeys.userAiProvider() });
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
    <form
      className="bg-muted/50 space-y-3 rounded-lg p-4"
      onSubmit={submit}
      noValidate
    >
      <div>
        <p className="text-sm font-medium">
          {t("settings.ai.responseTimeoutHeading")}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.responseTimeoutBody")}
        </p>
      </div>
      <div>
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
          placeholder={t("settings.ai.responseTimeoutPlaceholder")}
          className="mt-1 sm:max-w-xs"
        />
      </div>
      <div>
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
      </div>
      {msg && (
        <p className={`text-xs ${ok ? "text-success" : "text-destructive"}`}>
          {msg}
        </p>
      )}
    </form>
  );
}
