"use client";

/* ────────────────────────────────────────────────────────────────
 * Local (OpenAI-compatible) form — base URL + optional key + model.
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
  LOCAL_MODEL_PRESETS,
  uiToLegacyProviderEnum,
  type UserAIProvider,
} from "./shared";

export function LocalProviderForm({
  userProvider,
}: {
  userProvider: UserAIProvider | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelChoice, setModelChoice] = useState<string>("");
  const [customModel, setCustomModel] = useState("");
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
    if (userProvider?.provider === "LOCAL") {
      setBaseUrl(userProvider.baseUrl ?? "");
      const saved = userProvider.model ?? "";
      if (saved && (LOCAL_MODEL_PRESETS as readonly string[]).includes(saved)) {
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
        provider: uiToLegacyProviderEnum("local"),
        baseUrl: baseUrl.trim() || null,
        model: effectiveModel || null,
      };
      if (apiKey.trim()) body.localKey = apiKey.trim();
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
      data-testid="ai-provider-config-local"
      className="space-y-4"
      onSubmit={submit}
      noValidate
    >
      {/* v1.28.28 (#470) — name the gateway path explicitly. The Local
          provider is the ONE user-level custom-URL provider, so it is also
          the documented way to reach LiteLLM / OpenRouter / vLLM and any
          other OpenAI-compatible endpoint — not just an on-host model. */}
      <p className="text-muted-foreground text-xs">
        {t("settings.ai.localDescription")}
      </p>
      <div>
        <Label htmlFor="ai-local-base-url">
          {t("settings.ai.baseUrlLabel")}
        </Label>
        <Input
          id="ai-local-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:11434/v1"
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor="ai-local-key">{t("settings.ai.localKeyLabel")}</Label>
        <PasswordInput
          id="ai-local-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            userProvider?.hasLocalKey ? t("settings.ai.savedShort") : ""
          }
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor="ai-local-model">{t("settings.ai.modelLabel")}</Label>
        <NativeSelect
          id="ai-local-model"
          value={modelChoice}
          onChange={(e) => setModelChoice(e.target.value)}
          className="mt-1"
        >
          <option value="">{t("settings.ai.modelOptionDefault")}</option>
          {LOCAL_MODEL_PRESETS.map((m) => (
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
          <Label htmlFor="ai-local-model-custom">
            {t("settings.ai.customModelLabel")}
          </Label>
          <Input
            id="ai-local-model-custom"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="llama3:8b"
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
