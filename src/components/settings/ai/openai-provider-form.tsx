"use client";

/* ────────────────────────────────────────────────────────────────
 * OpenAI form — API key + model select + collapsed Base URL override.
 * Save mutation flips both `aiProvider` (for the legacy single-result
 * resolver) and `aiOpenaiKeyEncrypted` (the user's key) so an OPENAI
 * pick is visible to every code path that reads the row.
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
  CUSTOM_MODEL_SENTINEL,
  OPENAI_MODEL_PRESETS,
  uiToLegacyProviderEnum,
  type UserAIProvider,
} from "./shared";

export function OpenAIProviderForm({
  userProvider,
}: {
  userProvider: UserAIProvider | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [apiKey, setApiKey] = useState("");
  const [modelChoice, setModelChoice] = useState<string>("");
  const [customModel, setCustomModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const submitInFlightRef = useRef(false);

  const seededKey =
    userProvider != null
      ? `${userProvider.provider ?? ""}|${userProvider.model ?? ""}|${userProvider.baseUrl ?? ""}`
      : null;
  const [previousSeed, setPreviousSeed] = useState<string | null>(null);
  if (seededKey && seededKey !== previousSeed) {
    setPreviousSeed(seededKey);
    if (userProvider?.provider === "OPENAI") {
      const saved = userProvider.model ?? "";
      if (
        saved &&
        (OPENAI_MODEL_PRESETS as readonly string[]).includes(saved)
      ) {
        setModelChoice(saved);
        setCustomModel("");
      } else if (saved) {
        setModelChoice(CUSTOM_MODEL_SENTINEL);
        setCustomModel(saved);
      }
      setBaseUrl(userProvider.baseUrl ?? "");
    }
  }

  const effectiveModel =
    modelChoice === CUSTOM_MODEL_SENTINEL
      ? customModel.trim()
      : modelChoice.trim();

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: uiToLegacyProviderEnum("openai"),
        model: effectiveModel || null,
        baseUrl: baseUrl.trim() || null,
      };
      if (apiKey.trim()) body.openaiKey = apiKey.trim();
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
      data-testid="ai-provider-config-openai"
      className="space-y-4"
      onSubmit={submit}
      noValidate
    >
      <div>
        <Label htmlFor="ai-openai-key">
          {t("settings.ai.openai.apiKey")}
          {userProvider?.hasOpenaiKey && (
            <span className="text-muted-foreground ml-2 text-xs">
              {t("settings.ai.savedPreview", {
                preview: userProvider.openaiKeyPreview ?? "",
              })}
            </span>
          )}
        </Label>
        <PasswordInput
          id="ai-openai-key"
          data-testid="ai-openai-api-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("settings.ai.openai.apiKeyPlaceholder")}
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="ai-openai-model">
          {t("settings.ai.openai.modelSelect")}
        </Label>
        <NativeSelect
          id="ai-openai-model"
          data-testid="ai-openai-model"
          value={modelChoice}
          onChange={(e) => setModelChoice(e.target.value)}
          className="mt-1"
        >
          <option value="">{t("settings.ai.modelOptionDefault")}</option>
          {OPENAI_MODEL_PRESETS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM_MODEL_SENTINEL}>
            {t("settings.ai.openai.modelOptionCustom")}
          </option>
        </NativeSelect>
      </div>

      {modelChoice === CUSTOM_MODEL_SENTINEL && (
        <div>
          <Label htmlFor="ai-openai-model-custom">
            {t("settings.ai.openai.modelCustomLabel")}
          </Label>
          <Input
            id="ai-openai-model-custom"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder={t("settings.ai.openai.modelCustomPlaceholder")}
            className="mt-1"
          />
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-muted-foreground hover:text-foreground text-xs underline"
        >
          {showAdvanced
            ? t("settings.ai.openai.hideAdvanced")
            : t("settings.ai.openai.showAdvanced")}
        </button>
        {showAdvanced && (
          <div className="mt-2 space-y-1">
            <Label htmlFor="ai-openai-base-url">
              {t("settings.ai.openai.baseUrlLabel")}
            </Label>
            <Input
              id="ai-openai-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("settings.ai.openai.baseUrlPlaceholder")}
            />
            <p className="text-muted-foreground text-xs">
              {t("settings.ai.openai.baseUrlHelp")}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
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
