"use client";

/* ────────────────────────────────────────────────────────────────
 * Anthropic form — API key + model dropdown.
 * ──────────────────────────────────────────────────────────────── */

import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PasswordInput } from "@/components/ui/password-input";
import { apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import {
  ANTHROPIC_MODEL_PRESETS,
  CUSTOM_MODEL_SENTINEL,
  uiToLegacyProviderEnum,
  type UserAIProvider,
} from "./shared";

export function AnthropicProviderForm({
  userProvider,
}: {
  userProvider: UserAIProvider | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [apiKey, setApiKey] = useState("");
  const [modelChoice, setModelChoice] = useState<string>("");
  const [customModel, setCustomModel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const submitInFlightRef = useRef(false);

  const seededKey =
    userProvider != null
      ? `${userProvider.provider ?? ""}|${userProvider.model ?? ""}`
      : null;
  const [previousSeed, setPreviousSeed] = useState<string | null>(null);
  if (seededKey && seededKey !== previousSeed) {
    setPreviousSeed(seededKey);
    if (userProvider?.provider === "ANTHROPIC") {
      const saved = userProvider.model ?? "";
      if (
        saved &&
        (ANTHROPIC_MODEL_PRESETS as readonly string[]).includes(saved)
      ) {
        setModelChoice(saved);
        setCustomModel("");
      } else if (saved) {
        setModelChoice(CUSTOM_MODEL_SENTINEL);
        setCustomModel(saved);
      }
    }
  }

  const effectiveModel =
    modelChoice === CUSTOM_MODEL_SENTINEL
      ? customModel.trim()
      : modelChoice.trim();

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: uiToLegacyProviderEnum("anthropic"),
        model: effectiveModel || null,
      };
      if (apiKey.trim()) body.anthropicKey = apiKey.trim();
      await apiPatch("/api/user/ai-provider", body);
    },
    onSuccess: () => {
      setOk(true);
      setMsg(t("settings.ai.saved"));
      setApiKey("");
      queryClient.invalidateQueries({ queryKey: queryKeys.userAiProvider() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
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
      data-testid="ai-provider-config-anthropic"
      className="space-y-4"
      onSubmit={submit}
      noValidate
    >
      <div>
        <Label htmlFor="ai-anthropic-key">
          {t("settings.ai.anthropicKeyLabel")}
          {userProvider?.hasAnthropicKey && (
            <span className="text-muted-foreground ml-2 text-xs">
              {t("settings.ai.savedPreview", {
                preview: userProvider.anthropicKeyPreview ?? "",
              })}
            </span>
          )}
        </Label>
        <PasswordInput
          id="ai-anthropic-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-ant-…"
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="ai-anthropic-model">
          {t("settings.ai.modelLabel")}
        </Label>
        <NativeSelect
          id="ai-anthropic-model"
          value={modelChoice}
          onChange={(e) => setModelChoice(e.target.value)}
          className="mt-1"
        >
          <option value="">{t("settings.ai.modelOptionDefault")}</option>
          {ANTHROPIC_MODEL_PRESETS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM_MODEL_SENTINEL}>
            {t("settings.ai.modelOptionCustom")}
          </option>
        </NativeSelect>
      </div>

      {modelChoice === CUSTOM_MODEL_SENTINEL && (
        <div>
          <Label htmlFor="ai-anthropic-model-custom">
            {t("settings.ai.customModelLabel")}
          </Label>
          <Input
            id="ai-anthropic-model-custom"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="claude-3-5-sonnet-latest"
            className="mt-1"
          />
        </div>
      )}

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
