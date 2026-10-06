"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  ANTHROPIC_MODEL_PRESETS,
  LOCAL_MODEL_PRESETS,
  OPENAI_MODEL_PRESETS,
  uiToLegacyProviderEnum,
  type ProviderChainData,
  type ProviderType,
  type UserAIProvider,
} from "@/components/settings/ai/shared";
import { apiGet, apiPatch, apiPut } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";

/**
 * The quick model choice in the Coach's settings overlay: which provider
 * answers and which model it uses. How hard the Coach thinks is the Coach's
 * own setting since v1.41 (`coach-reasoning-field.tsx`); the provider's
 * reasoning select stays in Settings → AI for everything else.
 *
 * It is a shortcut onto the same settings Settings → AI writes, never a second
 * copy of them. Keys, base URLs, the Codex sign-in and the order of the
 * fallback chain stay there; this reads the same two queries and writes
 * through the same two routes:
 *  - Provider: `PUT /api/insights/provider-chain` with the chosen entry moved
 *    to the front and every other entry in its current order. The entries'
 *    reasoning settings are not sent, so the server keeps what it stored.
 *  - Model: `PATCH /api/user/ai-provider`, only where a person
 *    owns the setting (their own key's provider, or their gateway). The
 *    operator's shared provider and Codex show their state read-only.
 * Every write invalidates the AI input keys, so the capability on
 * `/api/auth/me` comes back from the server rather than being guessed here.
 */

/** The configured chain with `provider` first; everything else keeps order. */
export function chainWithFirst(
  chain: ProviderChainData["configuredChain"],
  provider: ProviderType,
): { providerType: ProviderType; priority: number; enabled: boolean }[] {
  const rest = chain.filter((entry) => entry.providerType !== provider);
  const ordered = [
    { providerType: provider, enabled: true },
    ...rest.map((entry) => ({
      providerType: entry.providerType,
      enabled: entry.enabled,
    })),
  ];
  return ordered.map((entry, idx) => ({ ...entry, priority: idx + 1 }));
}

/** The providers a person can switch to: enabled and able to answer. */
export function selectableProviders(
  chain: ProviderChainData["configuredChain"],
): ProviderType[] {
  return chain
    .filter((entry) => entry.enabled && entry.available)
    .map((entry) => entry.providerType);
}

/**
 * True when a saved switch did not take: the chain the server resolves after
 * the save is not led by the provider the person chose. A provider whose key
 * stops working between the read and the save lands here.
 */
export function switchDidNotTake(
  chosen: ProviderType,
  fresh: Pick<ProviderChainData, "activeProvider">,
): boolean {
  return fresh.activeProvider !== chosen;
}

/**
 * The provider the server answers with when the select has no option for it:
 * the operator's central Codex (never a chain entry), or an entry that answers
 * without being offered. Shown as a disabled option so the select tells the
 * truth instead of showing its first option as active.
 */
export function activeOutsideOptions(
  active: string | null,
  options: readonly string[],
): string | null {
  return active !== null && !options.includes(active) ? active : null;
}

export type ModelControl =
  | { kind: "preset"; presets: readonly string[]; value: string | null }
  | { kind: "gateway"; value: string | null }
  | { kind: "managed" };

const PRESETS: Partial<Record<ProviderType, readonly string[]>> = {
  openai: OPENAI_MODEL_PRESETS,
  anthropic: ANTHROPIC_MODEL_PRESETS,
  local: LOCAL_MODEL_PRESETS,
};

/**
 * Which model control the active provider gets. The model column is shared by
 * the OpenAI, Anthropic and Local providers and belongs to whichever of them
 * the person configured, so the control is offered only for that one; a
 * model name chosen for another would be sent to the wrong vendor.
 */
export function modelControlFor(
  active: ProviderType | null,
  userProvider: UserAIProvider | null | undefined,
): ModelControl {
  if (!active || !userProvider) return { kind: "managed" };
  if (active === "openai-compatible") {
    return { kind: "gateway", value: userProvider.compatModel };
  }
  const presets = PRESETS[active];
  if (presets && userProvider.provider === uiToLegacyProviderEnum(active)) {
    return { kind: "preset", presets, value: userProvider.model };
  }
  return { kind: "managed" };
}

export function CoachModelPicker() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const chainQuery = useQuery({
    queryKey: queryKeys.insightsProviderChain(),
    queryFn: () => apiGet<ProviderChainData>("/api/insights/provider-chain"),
  });
  const providerQuery = useQuery({
    queryKey: queryKeys.userAiProvider(),
    queryFn: () => apiGet<UserAIProvider>("/api/user/ai-provider"),
  });

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const onSaved = () => {
    setError(null);
    void invalidateKeys(queryClient, aiInputDependentKeys);
  };
  const onFailed = (e: unknown) =>
    setError(
      e instanceof Error && e.message
        ? e.message
        : t("insights.coach.frame.saveFailed"),
    );

  const switchProvider = useMutation({
    mutationFn: async (provider: ProviderType) => {
      setNotice(null);
      await apiPut("/api/insights/provider-chain", {
        chain: chainWithFirst(chainQuery.data?.configuredChain ?? [], provider),
      });
      // Read back what the server now resolves, so a switch that did not
      // take is said rather than shown as the select jumping back.
      return apiGet<ProviderChainData>("/api/insights/provider-chain");
    },
    onSuccess: (fresh, provider) => {
      queryClient.setQueryData(queryKeys.insightsProviderChain(), fresh);
      onSaved();
      if (switchDidNotTake(provider, fresh)) {
        setNotice(
          t("insights.coach.frame.providerNotActive", {
            provider: t(`settings.ai.providerChain.types.${provider}`),
          }),
        );
      }
    },
    onError: onFailed,
  });
  const patchProvider = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiPatch("/api/user/ai-provider", body),
    onSuccess: onSaved,
    onError: onFailed,
  });

  const chain = chainQuery.data;
  const userProvider = providerQuery.data;
  const active = chain?.activeProvider ?? null;
  const options = chain ? selectableProviders(chain.configuredChain) : [];
  const model = modelControlFor(active, userProvider);
  const busy = switchProvider.isPending || patchProvider.isPending;
  // The server may answer with `admin-codex`, which the UI's type omits.
  const unlisted = activeOutsideOptions(active as string | null, options);

  if (chainQuery.isError || providerQuery.isError) {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p role="alert" className="text-destructive">
          {t("common.loadFailed")}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void chainQuery.refetch();
            void providerQuery.refetch();
          }}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (!chain || !userProvider) {
    return (
      <p
        role="status"
        className="text-muted-foreground flex items-center gap-2 text-sm"
      >
        <Loader2
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {t("common.loading")}
      </p>
    );
  }

  return (
    <div data-slot="coach-model-picker" className="flex flex-col gap-4">
      <div>
        <Label htmlFor="coach-quick-provider" noColon>
          {t("insights.coach.frame.provider")}
        </Label>
        <NativeSelect
          id="coach-quick-provider"
          data-slot="coach-quick-provider"
          className="mt-1"
          value={active ?? ""}
          disabled={busy || options.length === 0}
          onChange={(e) => {
            const next = e.target.value as ProviderType;
            if (next && next !== active) switchProvider.mutate(next);
          }}
        >
          {active === null ? (
            <option value="" disabled>
              {t("insights.coach.frame.noProvider")}
            </option>
          ) : null}
          {unlisted ? (
            <option value={unlisted} disabled>
              {unlisted === "admin-codex"
                ? t("insights.coach.frame.operatorCodex")
                : t(`settings.ai.providerChain.types.${unlisted}`)}
            </option>
          ) : null}
          {options.map((p) => (
            <option key={p} value={p}>
              {t(`settings.ai.providerChain.types.${p}`)}
            </option>
          ))}
        </NativeSelect>
        {unlisted === "admin-codex" ? (
          <p
            data-slot="coach-quick-provider-operator"
            className="text-muted-foreground mt-1 text-xs"
          >
            {t("insights.coach.frame.operatorManaged")}
          </p>
        ) : null}
      </div>

      {model.kind === "preset" ? (
        <div>
          <Label htmlFor="coach-quick-model" noColon>
            {t("settings.ai.modelLabel")}
          </Label>
          <NativeSelect
            id="coach-quick-model"
            data-slot="coach-quick-model"
            className="mt-1"
            value={model.value ?? ""}
            disabled={busy}
            onChange={(e) =>
              patchProvider.mutate({ model: e.target.value || null })
            }
          >
            <option value="">{t("settings.ai.modelOptionDefault")}</option>
            {model.value && !model.presets.includes(model.value) ? (
              <option value={model.value}>{model.value}</option>
            ) : null}
            {model.presets.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : model.kind === "gateway" ? (
        <GatewayModelField
          key={model.value ?? ""}
          value={model.value}
          disabled={busy}
          onSave={(next) => patchProvider.mutate({ compatModel: next })}
        />
      ) : (
        <p
          data-slot="coach-quick-model-managed"
          className="text-muted-foreground text-xs"
        >
          {t("insights.coach.frame.modelManaged")}
        </p>
      )}

      {busy ? (
        <p role="status" className="text-muted-foreground text-xs">
          {t("insights.coach.frame.saving")}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          data-slot="coach-quick-provider-notice"
          className="text-muted-foreground text-xs"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A gateway names its own models, so its model is free text with a save. */
function GatewayModelField({
  value,
  disabled,
  onSave,
}: {
  value: string | null;
  disabled: boolean;
  onSave: (next: string | null) => void;
}) {
  const { t } = useTranslations();
  const [draft, setDraft] = useState(value ?? "");
  const changed = draft.trim() !== (value ?? "");
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave(draft.trim() || null);
      }}
    >
      <Label htmlFor="coach-quick-gateway-model" noColon>
        {t("settings.ai.modelLabel")}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id="coach-quick-gateway-model"
          data-slot="coach-quick-gateway-model"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={disabled}
          className="min-w-0 flex-1"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={disabled || !changed}
          className="min-h-11 sm:min-h-9"
        >
          {t("settings.ai.saveCta")}
        </Button>
      </div>
    </form>
  );
}
