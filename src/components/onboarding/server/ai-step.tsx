"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdminSettings } from "@/components/admin/_shared";
import { ChoiceChip } from "@/components/onboarding/choice-chip";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Segmented } from "@/components/ui/segmented";
import { apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";

import { useServerStep } from "./use-server-step";

type Mode = "off" | "own" | "server";
type Provider = "openai" | "anthropic" | "gemini";

/**
 * The services the server key can name here: the hosts the AI settings
 * route admits by default, each with its OpenAI-compatible address and a
 * model to start from. Another host needs `ADMIN_AI_BASE_URL_ALLOWLIST` and
 * stays an Admin › Coach matter.
 */
const PROVIDERS: Record<
  Provider,
  { label: string; baseUrl: string; model: string }
> = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-6",
  },
  gemini: {
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
  },
};

interface ServerKeyState {
  hasKey: boolean;
  keyPreview: string | null;
  model: string;
  baseUrl: string;
}

type TestState = "idle" | "running" | "ok" | { failed: string };

/**
 * Whether this server offers AI, and how (1.50). One choice:
 *
 *  - Off: the assistant master switch off.
 *  - Each person's own key: the switch on, no key of the server's; people
 *    add theirs in Settings › AI.
 *  - One key for everyone: the provider, the key and the model, inline, and
 *    "Test" asks the provider through the server (the browser may not reach
 *    an AI host from here). Every person still says yes or no for
 *    themselves; the sentence says so.
 *
 * Each answer is written through the admin routes Admin › Coach uses. A
 * stored key is never echoed back, only its last four characters.
 */
export function AiStep() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const settings = useAdminSettings();
  const serverKey = useQuery({
    queryKey: queryKeys.adminAiServerKey(),
    queryFn: () => apiGet<ServerKeyState>("/api/admin/ai-settings"),
  });
  const step = useServerStep("ai");
  const [mode, setMode] = useState<Mode | null>(null);
  const [provider, setProvider] = useState<Provider>("openai");
  const [key, setKey] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>("idle");
  const [working, setWorking] = useState(false);

  const modelValue = model ?? PROVIDERS[provider].model;
  const keyOnFile = serverKey.data?.hasKey === true;
  const ready =
    mode === "off" ||
    mode === "own" ||
    (mode === "server" && (key.trim().length > 0 || keyOnFile));

  async function writeServerKey() {
    await apiPut("/api/admin/ai-settings", {
      baseUrl: PROVIDERS[provider].baseUrl,
      model: modelValue.trim(),
      ...(key.trim() ? { apiKey: key.trim() } : {}),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.adminAiServerKey(),
    });
    // The server key is a provider input of every account's AI answer.
    void invalidateKeys(queryClient, aiInputDependentKeys);
  }

  async function writeMaster(enabled: boolean) {
    if (settings.data?.assistantEnabled === enabled) return;
    await apiPut("/api/admin/settings", { assistantEnabled: enabled });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.adminSettings(),
    });
  }

  async function runTest() {
    setTest("running");
    try {
      await writeServerKey();
      await writeMaster(true);
      const result = await apiPost<{ ok: boolean; reason?: string }>(
        "/api/ai/test",
        {},
      );
      setTest(result.ok ? "ok" : { failed: result.reason ?? "" });
    } catch (err) {
      setTest({ failed: err instanceof Error ? err.message : "" });
    }
  }

  async function next() {
    if (!ready || working) return;
    setWorking(true);
    try {
      if (mode === "server") await writeServerKey();
      await writeMaster(mode !== "off");
      await step.record("done");
    } catch (err) {
      setWorking(false);
      step.fail(err);
    }
  }

  async function notNow() {
    if (working) return;
    setWorking(true);
    try {
      await step.record("skipped");
    } catch (err) {
      setWorking(false);
      step.fail(err);
    }
  }

  return (
    <section
      aria-labelledby="server-setup-ai-title"
      className="flex flex-1 flex-col"
      data-slot="server-setup-step"
      data-step="ai"
    >
      <StepHeading
        id="server-setup-ai-title"
        title={t("setup.server.ai.title")}
        description={t("setup.server.ai.body")}
        tone="foreground"
      />
      <fieldset className="grid gap-2">
        <legend className="sr-only">{t("setup.server.ai.title")}</legend>
        <ChoiceChip
          name="server-setup-ai"
          value="off"
          kind="single"
          checked={mode === "off"}
          onChange={() => setMode("off")}
          label={t("setup.server.ai.off")}
        />
        <ChoiceChip
          name="server-setup-ai"
          value="own"
          kind="single"
          checked={mode === "own"}
          onChange={() => setMode("own")}
          label={t("setup.server.ai.own")}
          hint={t("setup.server.ai.ownHint")}
        />
        <ChoiceChip
          name="server-setup-ai"
          value="server"
          kind="single"
          checked={mode === "server"}
          onChange={() => setMode("server")}
          label={t("setup.server.ai.server")}
          hint={t("setup.server.ai.serverHint")}
        >
          <ServerKeyFields
            provider={provider}
            onProvider={(next) => {
              setProvider(next);
              setModel(null);
              setTest("idle");
            }}
            apiKey={key}
            onApiKey={(next) => {
              setKey(next);
              setTest("idle");
            }}
            model={modelValue}
            onModel={(next) => {
              setModel(next);
              setTest("idle");
            }}
            keyPreview={keyOnFile ? (serverKey.data?.keyPreview ?? null) : null}
            test={test}
            onTest={() => void runTest()}
            testDisabled={!ready || test === "running"}
          />
        </ChoiceChip>
      </fieldset>
      <StepActions
        secondary={{
          label: t("setup.notNow"),
          onClick: () => void notNow(),
        }}
        primary={{
          label: t("onboarding.shell.next"),
          onClick: () => void next(),
          disabled: !ready,
        }}
        pending={working}
      />
    </section>
  );
}

/** The server key's fields, inside the chosen "One key for everyone" row. */
function ServerKeyFields({
  provider,
  onProvider,
  apiKey,
  onApiKey,
  model,
  onModel,
  keyPreview,
  test,
  onTest,
  testDisabled,
}: {
  provider: Provider;
  onProvider: (next: Provider) => void;
  apiKey: string;
  onApiKey: (next: string) => void;
  model: string;
  onModel: (next: string) => void;
  /** The last four characters of a key on file, never the key. */
  keyPreview: string | null;
  test: TestState;
  onTest: () => void;
  testDisabled: boolean;
}) {
  const { t } = useTranslations();
  return (
    <>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("setup.server.ai.provider")}</p>
        <Segmented
          label={t("setup.server.ai.provider")}
          size="sm"
          value={provider}
          onChange={onProvider}
          options={(Object.keys(PROVIDERS) as Provider[]).map((id) => ({
            value: id,
            label: PROVIDERS[id].label,
          }))}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="server-setup-ai-key">{t("setup.server.ai.key")}</Label>
        <PasswordInput
          id="server-setup-ai-key"
          value={apiKey}
          onChange={(e) => onApiKey(e.target.value)}
          placeholder={
            keyPreview
              ? t("admin.aiServerKey.keyPlaceholderSet", {
                  preview: keyPreview,
                })
              : undefined
          }
          autoComplete="off"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="server-setup-ai-model">
          {t("admin.aiServerKey.modelLabel")}
        </Label>
        <Input
          id="server-setup-ai-model"
          value={model}
          onChange={(e) => onModel(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={testDisabled}
          onClick={onTest}
          data-slot="server-setup-ai-test"
        >
          {t("setup.server.ai.test")}
        </Button>
        {test === "ok" ? (
          <WrittenOutcomeLine
            outcome="success"
            message={t("setup.server.ai.testOk")}
            testId="server-setup-ai-test-ok"
          />
        ) : typeof test === "object" ? (
          <WrittenOutcomeLine
            outcome="failed"
            message={test.failed || t("setup.server.ai.testFailed")}
            testId="server-setup-ai-test-failed"
          />
        ) : null}
      </div>
    </>
  );
}
