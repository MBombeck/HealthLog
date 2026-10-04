"use client";

/* ────────────────────────────────────────────────────────────────
 * OpenAI-compatible gateway form (#470) — base URL + optional key +
 * model. Three fields of its own, written to three columns of its own:
 * the OpenAI provider stays pinned to api.openai.com and cannot see any
 * of them, and the gateway never sees the OpenAI key.
 * ──────────────────────────────────────────────────────────────── */

import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { aiInputDependentKeys, invalidateKeys } from "@/lib/query-keys";

import { ReasoningEffortField } from "./reasoning-effort-field";
import {
  uiToLegacyProviderEnum,
  type ReasoningEffort,
  type UserAIProvider,
} from "./shared";

export function CompatProviderForm({
  userProvider,
}: {
  userProvider: UserAIProvider | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState<ReasoningEffort | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const submitInFlightRef = useRef(false);

  // Seed from the server once per distinct persisted value, the same
  // render-time pattern the sibling forms use (no setState-in-effect).
  const seededKey =
    userProvider != null
      ? `${userProvider.compatBaseUrl ?? ""}|${userProvider.compatModel ?? ""}|${userProvider.compatReasoningEffort ?? ""}`
      : null;
  const [previousSeed, setPreviousSeed] = useState<string | null>(null);
  if (seededKey && seededKey !== previousSeed) {
    setPreviousSeed(seededKey);
    setBaseUrl(userProvider?.compatBaseUrl ?? "");
    setModel(userProvider?.compatModel ?? "");
    setReasoning(userProvider?.compatReasoningEffort ?? null);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: uiToLegacyProviderEnum("openai-compatible"),
        compatBaseUrl: baseUrl.trim() || null,
        compatModel: model.trim() || null,
        compatReasoningEffort: reasoning,
      };
      if (apiKey.trim()) body.compatKey = apiKey.trim();
      await apiPatch("/api/user/ai-provider", body);
    },
    onSuccess: () => {
      setOk(true);
      setMsg(t("settings.ai.saved"));
      setApiKey("");
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
    <form
      data-testid="ai-provider-config-openai-compatible"
      className="space-y-4"
      onSubmit={submit}
      noValidate
    >
      <p className="text-muted-foreground text-xs">
        {t("settings.ai.compat.description")}
      </p>
      <div>
        <Label htmlFor="ai-compat-base-url">
          {t("settings.ai.baseUrlLabel")}
        </Label>
        <Input
          id="ai-compat-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://litellm.example.com/v1"
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor="ai-compat-key">
          {t("settings.ai.compat.keyLabel")}
        </Label>
        <PasswordInput
          id="ai-compat-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            userProvider?.hasCompatKey ? t("settings.ai.savedShort") : ""
          }
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor="ai-compat-model">{t("settings.ai.modelLabel")}</Label>
        <Input
          id="ai-compat-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="anthropic/claude-sonnet-4-6"
          className="mt-1"
        />
        <p className="text-muted-foreground mt-1 text-xs">
          {t("settings.ai.compat.modelHint")}
        </p>
      </div>
      <ReasoningEffortField
        id="ai-compat-reasoning"
        value={reasoning}
        onChange={setReasoning}
      />

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
