"use client";

/* ────────────────────────────────────────────────────────────────
 * Chains per task (#1404) — named provider chains next to the
 * fallback chain, and which AI task follows which chain. A task left
 * on Default keeps the rules it always had; a task with its own chain
 * uses exactly that chain, and a one-entry chain is a binding.
 *
 * The egress of every entry (stays on this machine / leaves it) comes
 * from the server; whether a task is available at all comes from the
 * `ai` block on /api/auth/me, never from here.
 * ──────────────────────────────────────────────────────────────── */

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Loader2, PlusCircle, Route, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";
import { randomId } from "@/lib/random-id";

import {
  ChainTile,
  DefaultChainSelect,
  TaskList,
  type ProviderInfo,
} from "./named-chains-parts";
import type {
  ChainProviderType,
  NamedChainsData,
  NamedChainView,
} from "./shared";

/** How many named chains a record may hold; mirrors the server's cap. */
const MAX_CHAINS = 10;

interface Draft {
  chains: NamedChainView[];
  defaultChainId: string | null;
  attachments: Record<string, string>;
}

function draftFrom(data: NamedChainsData): Draft {
  return {
    chains: data.chains.map((chain) => ({
      ...chain,
      entries: [...chain.entries],
    })),
    defaultChainId: data.defaultChainId,
    attachments: { ...data.attachments } as Record<string, string>,
  };
}

/** Whether every chain has a name, and no two share one (ignoring case). */
function chainNameIssue(
  chains: readonly NamedChainView[],
): "required" | "taken" | null {
  const seen = new Set<string>();
  for (const chain of chains) {
    const name = chain.name.trim().toLowerCase();
    if (!name) return "required";
    if (seen.has(name)) return "taken";
    seen.add(name);
  }
  return null;
}

/**
 * The draft with one more chain, named "Chain n" with the first free n. It
 * starts from the head of the fallback chain, so it is valid the moment it
 * exists; the person edits it from there.
 */
function withNewChain(
  prev: Draft,
  data: NamedChainsData,
  nameFor: (n: number) => string,
): Draft {
  const taken = new Set(prev.chains.map((c) => c.name.toLowerCase()));
  let n = prev.chains.length + 1;
  while (taken.has(nameFor(n).toLowerCase())) n += 1;
  // The first provider that is set up, in the fallback chain's order: the
  // head of that chain can be one that is not set up yet, and a new chain
  // seeded with it could not answer anything.
  const isAvailable = (type: ChainProviderType) =>
    data.providers.some((p) => p.providerType === type && p.available);
  const first =
    data.mainChain.find(isAvailable) ??
    data.providers.find((p) => p.available)?.providerType ??
    data.mainChain[0] ??
    "local";
  const id = `c${randomId().replace(/-/g, "").slice(0, 15)}`;
  return {
    ...prev,
    chains: [...prev.chains, { id, name: nameFor(n), entries: [first] }],
  };
}

/** The draft without one chain: its tasks go back to Default. */
function withoutChain(prev: Draft, id: string): Draft {
  return {
    chains: prev.chains.filter((chain) => chain.id !== id),
    defaultChainId: prev.defaultChainId === id ? null : prev.defaultChainId,
    attachments: Object.fromEntries(
      Object.entries(prev.attachments).filter(([, chainId]) => chainId !== id),
    ),
  };
}

/**
 * The chains read. Called beside the other AI settings reads so it runs in
 * parallel with them, never after them.
 */
export function useNamedChainsQuery(
  enabled: boolean,
): UseQueryResult<NamedChainsData> {
  return useQuery({
    queryKey: queryKeys.insightsProviderChains(),
    queryFn: () => apiGet<NamedChainsData>("/api/insights/provider-chains"),
    enabled,
  });
}

export function NamedChainsCard({
  query,
}: {
  /** The read, as `useNamedChainsQuery` returns it. */
  query: {
    data: NamedChainsData | undefined;
    isPending: boolean;
    error: unknown;
    refetch: () => unknown;
  };
}) {
  const { t } = useTranslations();

  return (
    <SettingsCard data-testid="ai-named-chains">
      <SettingsCardHeader
        anchor="provider-chains"
        icon={Route}
        title={t("settings.ai.namedChains.title")}
        description={t("settings.ai.namedChains.description")}
      />
      {query.error ? (
        <QueryErrorRow
          error={query.error}
          onRetry={() => void query.refetch()}
          inset
        />
      ) : query.isPending || !query.data ? (
        <Skeleton className="h-32 w-full rounded-lg" />
      ) : (
        <NamedChainsEditor data={query.data} />
      )}
    </SettingsCard>
  );
}

function NamedChainsEditor({ data }: { data: NamedChainsData }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // A working copy, reseeded whenever the server's state changes, so several
  // edits can be made before one save.
  const seededKey = JSON.stringify([
    data.chains,
    data.defaultChainId,
    data.attachments,
  ]);
  const [seeded, setSeeded] = useState(seededKey);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(data));
  if (seededKey !== seeded) {
    setSeeded(seededKey);
    setDraft(draftFrom(data));
  }
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const providers: ProviderInfo = new Map(
    data.providers.map((p) => [p.providerType, p]),
  );
  const nameIssue = chainNameIssue(draft.chains);

  const save = useMutation({
    mutationFn: (next: Draft) =>
      apiPut<NamedChainsData>("/api/insights/provider-chains", {
        chains: next.chains.map((chain) => ({
          id: chain.id,
          name: chain.name.trim(),
          entries: chain.entries,
        })),
        defaultChainId: next.defaultChainId,
        attachments: next.attachments,
      }),
    onSuccess: (saved) => {
      setResult({ ok: true, message: t("settings.ai.namedChains.saved") });
      queryClient.setQueryData(queryKeys.insightsProviderChains(), saved);
      void invalidateKeys(queryClient, aiInputDependentKeys);
    },
    onError: (e) => {
      setResult({
        ok: false,
        message: localizedApiError(e, t, "settings.ai.namedChains.saveFailed"),
      });
    },
  });

  function edit(change: (prev: Draft) => Draft) {
    setResult(null);
    setDraft(change);
  }

  function addChain() {
    edit((prev) =>
      withNewChain(prev, data, (n) =>
        t("settings.ai.namedChains.newChainName", { n }),
      ),
    );
  }

  const outcome = nameIssue
    ? {
        ok: false,
        message: t(
          nameIssue === "required"
            ? "settings.ai.namedChains.nameRequired"
            : "settings.ai.namedChains.nameTaken",
        ),
      }
    : result;

  return (
    <>
      {draft.chains.length === 0 ? (
        <EmptyState
          variant="plain"
          size="compact"
          data-slot="named-chains-empty"
          title={t("settings.ai.namedChains.empty")}
        />
      ) : (
        <ul className="space-y-3" data-slot="named-chain-list">
          {draft.chains.map((chain) => (
            <ChainTile
              key={chain.id}
              chain={chain}
              isDefault={draft.defaultChainId === chain.id}
              usedBy={
                Object.values(draft.attachments).filter((id) => id === chain.id)
                  .length
              }
              providers={providers}
              onChange={(next) =>
                edit((prev) => ({
                  ...prev,
                  chains: prev.chains.map((c) =>
                    c.id === chain.id ? next : c,
                  ),
                }))
              }
              onMakeDefault={() =>
                edit((prev) => ({ ...prev, defaultChainId: chain.id }))
              }
              onDelete={() => edit((prev) => withoutChain(prev, chain.id))}
            />
          ))}
        </ul>
      )}

      {draft.chains.length < MAX_CHAINS && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={addChain}
            data-testid="ai-named-chains-add"
          >
            <PlusCircle className="h-4 w-4" />
            {t("settings.ai.namedChains.newChain")}
          </Button>
        </div>
      )}

      {draft.chains.length > 0 && (
        <DefaultChainSelect
          chains={draft.chains}
          value={draft.defaultChainId}
          onChange={(value) =>
            edit((prev) => ({ ...prev, defaultChainId: value }))
          }
        />
      )}

      <TaskList
        chains={draft.chains}
        attachments={draft.attachments}
        providers={providers}
        onAttach={(capability, chainId) =>
          edit((prev) => {
            const attachments = { ...prev.attachments };
            if (chainId) attachments[capability] = chainId;
            else delete attachments[capability];
            return { ...prev, attachments };
          })
        }
      />

      {outcome && (
        <WrittenOutcomeLine
          outcome={outcome.ok ? "success" : "failed"}
          message={outcome.message}
          testId="ai-named-chains-outcome"
        />
      )}
      <SettingsCardActions>
        <Button
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => save.mutate(draft)}
          disabled={save.isPending || nameIssue !== null}
          data-testid="ai-named-chains-save"
        >
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {t("settings.ai.namedChains.save")}
        </Button>
      </SettingsCardActions>
    </>
  );
}
