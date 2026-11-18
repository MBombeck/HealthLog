"use client";

/**
 * State and actions of the Antigravity settings card: the profile status, the
 * model list, the connection test, the connect dialog, and the model choice.
 * The card renders these; this file talks to the API.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { apiGet, apiPatch, apiPost, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import { aiInputDependentKeys, invalidateKeys } from "@/lib/query-keys";
import type { AntigravityStatusResponse } from "@/app/api/antigravity/status/route";
import type { AntigravityTestResponse } from "@/app/api/antigravity/test/route";
import type { AntigravityDisconnectResponse } from "@/app/api/antigravity/disconnect/route";
import type {
  AntigravityModelsReason,
  AntigravityModelsResponse,
} from "@/app/api/antigravity/models/route";
import type { AntigravityModelResponse } from "@/app/api/antigravity/model/route";
import type { ProviderChainData, ReasoningEffort } from "./shared";

type Busy = "test" | "disconnect" | "model" | "install" | "update";
type Translate = ReturnType<typeof useTranslations>["t"];
type ChainEntry = { providerType: string; enabled: boolean };

async function addAntigravityToChain() {
  const chain = await apiGet<ProviderChainData>("/api/insights/provider-chain");
  const entries: ChainEntry[] = chain.configuredChain.map((e) => ({
    providerType: e.providerType,
    enabled: e.enabled,
  }));
  const existing = entries.find((e) => e.providerType === "antigravity");
  if (!existing) {
    entries.unshift({ providerType: "antigravity", enabled: true });
  } else {
    existing.enabled = true;
  }
  await apiPut("/api/insights/provider-chain", { chain: entries });
}

async function removeAntigravityFromChain() {
  const chain = await apiGet<ProviderChainData>("/api/insights/provider-chain");
  const entries: ChainEntry[] = chain.configuredChain
    .filter((e) => e.providerType !== "antigravity")
    .map((e) => ({ providerType: e.providerType, enabled: e.enabled }));
  await apiPut("/api/insights/provider-chain", { chain: entries });
}

/** The sentence for a reason a test or a model list did not pass. */
export function reasonText(
  t: Translate,
  reason: NonNullable<
    AntigravityTestResponse["reason"] | AntigravityModelsReason
  >,
): string {
  switch (reason) {
    case "not_set_up":
      return t("settings.ai.antigravity.reasonNotSetUp");
    case "profile_missing":
      return t("settings.ai.antigravity.reasonProfileMissing");
    case "cli_unavailable":
      return t("settings.ai.antigravity.cliNotFound");
    case "auth_required":
      return t("settings.ai.antigravity.statusAuthRequired");
    case "timeout":
      return t("settings.ai.antigravity.reasonTimeout");
    case "cli_error":
      return t("settings.ai.antigravity.reasonFailed");
    case "no_models":
      return t("settings.ai.antigravity.noModels");
  }
}

export function useAntigravityProfile(callbacks?: {
  onProviderChanged?: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<AntigravityStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [models, setModels] = useState<AntigravityModelsResponse | null>(null);
  const [reasoning, setReasoning] = useState<ReasoningEffort | null>(null);
  const [antigravityEnabled, setAntigravityEnabled] = useState(false);

  const connected = status?.connectionStatus === "connected";
  const connectedAt = status?.connectedAt ?? null;

  useEffect(() => {
    let active = true;
    apiGet<AntigravityStatusResponse>("/api/antigravity/status")
      .then((data) => {
        if (active) setStatus(data);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // The model list comes from the CLI, which starts a process. Load it only
  // when the profile is connected, and again after each successful test.
  useEffect(() => {
    if (!connected) return;
    let active = true;
    apiGet<AntigravityModelsResponse>("/api/antigravity/models")
      .then((data) => {
        if (active) setModels(data);
      })
      .catch(() => {
        if (active) {
          setModels({ models: [], selectedModel: null, reason: "cli_error" });
        }
      });
    apiGet<ProviderChainData>("/api/insights/provider-chain")
      .then((data) => {
        if (!active) return;
        const entry = data.configuredChain.find(
          (e) => e.providerType === "antigravity",
        );
        setAntigravityEnabled(Boolean(entry?.enabled));
        if (entry && entry.reasoningEffort !== undefined) {
          setReasoning(entry.reasoningEffort);
        }
      })
      .catch(() => {
        if (active) setNotice(t("settings.ai.antigravity.reasonFailed"));
      });
    return () => {
      active = false;
    };
  }, [connected, connectedAt]);

  async function refresh() {
    setStatus(
      await apiGet<AntigravityStatusResponse>("/api/antigravity/status"),
    );
  }

  async function run(kind: Busy, action: () => Promise<void>) {
    setBusy(kind);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice(
        localizedApiError(error, t, "settings.ai.antigravity.reasonFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleConnected() {
    await addAntigravityToChain();
    void invalidateKeys(queryClient, aiInputDependentKeys);
    callbacks?.onProviderChanged?.();
    toastWrittenOutcome("success", t("settings.ai.antigravity.connectSuccess"));
    await refresh();
  }

  function test() {
    return run("test", async () => {
      // The test starts the CLI and can take up to a minute, so the default
      // request timeout does not apply.
      const result = await apiPost<AntigravityTestResponse>(
        "/api/antigravity/test",
        undefined,
        { signal: null },
      );
      if (result.reason) setNotice(reasonText(t, result.reason));
      await refresh();
    });
  }

  function disconnect() {
    return run("disconnect", async () => {
      await apiPost<AntigravityDisconnectResponse>(
        "/api/antigravity/disconnect",
      );
      await removeAntigravityFromChain();
      void invalidateKeys(queryClient, aiInputDependentKeys);
      callbacks?.onProviderChanged?.();
      toastWrittenOutcome(
        "success",
        t("settings.ai.antigravity.disconnectSuccess"),
      );
      await refresh();
    });
  }

  function changeModel(model: string | null) {
    return run("model", async () => {
      const result = await apiPatch<AntigravityModelResponse>(
        "/api/antigravity/model",
        { model },
      );
      setModels((current) =>
        current ? { ...current, selectedModel: result.selectedModel } : current,
      );
      try {
        const refreshed = await apiGet<AntigravityModelsResponse>(
          "/api/antigravity/models",
        );
        setModels(refreshed);
      } catch {
        // Clear stale thought levels on failed refresh so old model choices don't linger
        setModels((current) =>
          current
            ? {
                ...current,
                selectedModel: result.selectedModel,
                thoughtLevels: undefined,
              }
            : current,
        );
      }
      toastWrittenOutcome("success", t("settings.ai.antigravity.modelSaved"));
    });
  }

  function changeReasoning(effort: ReasoningEffort | null) {
    return run("model", async () => {
      const chain = await apiGet<ProviderChainData>(
        "/api/insights/provider-chain",
      );
      const entry = chain.configuredChain.find(
        (e) => e.providerType === "antigravity",
      );
      if (!entry || !entry.enabled) {
        setNotice(t("settings.ai.antigravity.reasonFailed"));
        return;
      }
      const entries = chain.configuredChain.map((e) => ({
        providerType: e.providerType,
        enabled: e.enabled,
        reasoningEffort:
          e.providerType === "antigravity"
            ? (effort ?? null)
            : (e.reasoningEffort ?? undefined),
      }));
      await apiPut("/api/insights/provider-chain", { chain: entries });
      setReasoning(effort);
      setAntigravityEnabled(true);
      void invalidateKeys(queryClient, aiInputDependentKeys);
      toastWrittenOutcome("success", t("settings.ai.saved"));
    });
  }

  function installCli() {
    return run("install", async () => {
      await apiPost("/api/antigravity/install", {});
      toastWrittenOutcome(
        "success",
        t("settings.ai.antigravity.installCliSuccess"),
      );
      await refresh();
    });
  }

  function updateCli() {
    return run("update", async () => {
      await apiPost("/api/antigravity/install", { action: "update" });
      toastWrittenOutcome(
        "success",
        t("settings.ai.antigravity.updateCliSuccess"),
      );
      await refresh();
    });
  }

  return {
    status,
    loading,
    loadFailed,
    busy,
    notice,
    connectOpen,
    models,
    reasoning,
    antigravityEnabled,
    connected,
    openConnect: () => setConnectOpen(true),
    closeConnect: () => setConnectOpen(false),
    handleConnected,
    test,
    disconnect,
    changeModel,
    changeReasoning,
    installCli,
    updateCli,
  };
}
