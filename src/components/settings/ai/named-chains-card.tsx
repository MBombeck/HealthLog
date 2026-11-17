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

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Cloud,
  HardDrive,
  Loader2,
  PlusCircle,
  Route,
  Save,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import {
  aiInputDependentKeys,
  invalidateKeys,
  queryKeys,
} from "@/lib/query-keys";

import {
  NAMED_CHAIN_CAPABILITIES,
  type NamedChainsData,
  type NamedChainView,
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

function newChainId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2);
  return `c${random.slice(0, 15)}`;
}

export function NamedChainsCard({
  data,
  isPending,
  error,
  onRetry,
}: {
  data: NamedChainsData | undefined;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
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
      {error ? (
        <QueryErrorRow error={error} onRetry={onRetry} inset />
      ) : isPending || !data ? (
        <Skeleton className="h-32 w-full rounded-lg" />
      ) : (
        <NamedChainsEditor data={data} />
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

  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const providerInfo = useMemo(
    () => new Map(data.providers.map((p) => [p.providerType, p])),
    [data.providers],
  );

  const nameIssue = chainNameIssue(draft.chains);
  const nameProblem =
    nameIssue === "required"
      ? t("settings.ai.namedChains.nameRequired")
      : nameIssue === "taken"
        ? t("settings.ai.namedChains.nameTaken")
        : null;

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
      setOk(true);
      setMsg(t("settings.ai.namedChains.saved"));
      queryClient.setQueryData(queryKeys.insightsProviderChains(), saved);
      void invalidateKeys(queryClient, aiInputDependentKeys);
    },
    onError: (e) => {
      setOk(false);
      setMsg(localizedApiError(e, t, "settings.ai.namedChains.saveFailed"));
    },
  });

  function updateChain(
    id: string,
    change: (c: NamedChainView) => NamedChainView,
  ) {
    setMsg(null);
    setDraft((prev) => ({
      ...prev,
      chains: prev.chains.map((chain) =>
        chain.id === id ? change(chain) : chain,
      ),
    }));
  }

  function addChain() {
    setMsg(null);
    setDraft((prev) => {
      const taken = new Set(prev.chains.map((c) => c.name.toLowerCase()));
      let n = prev.chains.length + 1;
      while (
        taken.has(
          t("settings.ai.namedChains.newChainName", { n }).toLowerCase(),
        )
      ) {
        n += 1;
      }
      // A new chain starts from the head of the fallback chain, so it is
      // valid the moment it exists; the person edits it from there.
      const first =
        data.mainChain[0] ??
        data.providers.find((p) => p.available)?.providerType ??
        "local";
      return {
        ...prev,
        chains: [
          ...prev.chains,
          {
            id: newChainId(),
            name: t("settings.ai.namedChains.newChainName", { n }),
            entries: [first],
          },
        ],
      };
    });
  }

  function deleteChain(id: string) {
    setMsg(null);
    setDraft((prev) => ({
      chains: prev.chains.filter((chain) => chain.id !== id),
      defaultChainId: prev.defaultChainId === id ? null : prev.defaultChainId,
      attachments: Object.fromEntries(
        Object.entries(prev.attachments).filter(
          ([, chainId]) => chainId !== id,
        ),
      ),
    }));
  }

  function attach(capability: string, chainId: string) {
    setMsg(null);
    setDraft((prev) => {
      const attachments = { ...prev.attachments };
      if (chainId) attachments[capability] = chainId;
      else delete attachments[capability];
      return { ...prev, attachments };
    });
  }

  const providerName = (type: string) =>
    t(`settings.ai.providerChain.types.${type}`);
  const defaultChain = draft.chains.find((c) => c.id === draft.defaultChainId);
  const defaultEntries = defaultChain?.entries ?? data.mainChain;
  const mainName = t("settings.ai.providerChain.title");

  return (
    <>
      {draft.chains.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("settings.ai.namedChains.empty")}
        </p>
      ) : (
        <ul className="space-y-3" data-slot="named-chain-list">
          {draft.chains.map((chain) => {
            const used = Object.values(draft.attachments).filter(
              (id) => id === chain.id,
            ).length;
            const isDefault = draft.defaultChainId === chain.id;
            return (
              <li
                key={chain.id}
                data-named-chain={chain.id}
                className="border-border space-y-3 rounded-lg border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={chain.name}
                    maxLength={40}
                    aria-label={t("settings.ai.namedChains.nameLabel")}
                    onChange={(e) =>
                      updateChain(chain.id, (c) => ({
                        ...c,
                        name: e.target.value,
                      }))
                    }
                    className="min-w-0 flex-1 basis-40"
                  />
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {isDefault ? (
                      <Badge variant="secondary">
                        {t("settings.ai.namedChains.defaultBadge")}
                      </Badge>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-11 sm:min-h-9"
                        onClick={() => {
                          setMsg(null);
                          setDraft((prev) => ({
                            ...prev,
                            defaultChainId: chain.id,
                          }));
                        }}
                      >
                        <Star className="h-4 w-4" />
                        {t("settings.ai.namedChains.makeDefault")}
                      </Button>
                    )}
                    <ConfirmButton
                      label={t("settings.ai.namedChains.deleteChain")}
                      ariaLabel={t("settings.ai.namedChains.deleteChain")}
                      title={t("settings.ai.namedChains.deleteConfirmTitle", {
                        name: chain.name.trim() || "…",
                      })}
                      body={
                        used > 0 || isDefault
                          ? t("settings.ai.namedChains.deleteConfirmBodyUsed", {
                              count: used,
                            })
                          : t("settings.ai.namedChains.deleteConfirmBody")
                      }
                      confirmLabel={t("settings.ai.namedChains.deleteChain")}
                      onConfirm={() => deleteChain(chain.id)}
                      size="icon"
                      className="text-destructive min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                      icon={<Trash2 className="h-4 w-4" />}
                      destructive
                    />
                  </div>
                </div>

                <ol className="space-y-2">
                  {chain.entries.map((type, idx) => (
                    <li
                      key={type}
                      data-chain-entry={type}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1"
                    >
                      <span className="text-muted-foreground w-5 text-center text-xs tabular-nums">
                        {idx + 1}.
                      </span>
                      <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-0">
                        <p className="text-sm font-medium">
                          {providerName(type)}
                        </p>
                        <EntryMeta
                          egress={providerInfo.get(type)?.egress ?? "external"}
                          available={providerInfo.get(type)?.available ?? false}
                        />
                      </div>
                      <div className="ml-auto flex shrink-0 items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={t("settings.ai.providerChain.moveUp")}
                          disabled={idx === 0}
                          onClick={() =>
                            updateChain(chain.id, (c) => ({
                              ...c,
                              entries: swap(c.entries, idx, idx - 1),
                            }))
                          }
                          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={t("settings.ai.providerChain.moveDown")}
                          disabled={idx === chain.entries.length - 1}
                          onClick={() =>
                            updateChain(chain.id, (c) => ({
                              ...c,
                              entries: swap(c.entries, idx, idx + 1),
                            }))
                          }
                          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={t(
                            "settings.ai.providerChain.removeFromChain",
                          )}
                          disabled={chain.entries.length <= 1}
                          onClick={() =>
                            updateChain(chain.id, (c) => ({
                              ...c,
                              entries: c.entries.filter((_, i) => i !== idx),
                            }))
                          }
                          className="text-destructive min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>

                {chain.entries.length === 1 && (
                  <p className="text-muted-foreground text-xs">
                    {t("settings.ai.namedChains.bindingHint")}
                  </p>
                )}

                <AddEntry
                  options={data.providers
                    .filter(
                      (p) =>
                        !chain.entries.includes(p.providerType) &&
                        (p.available || p.providerType !== "admin-codex"),
                    )
                    .map((p) => p.providerType)}
                  onAdd={(type) =>
                    updateChain(chain.id, (c) => ({
                      ...c,
                      entries: [...c.entries, type],
                    }))
                  }
                />
              </li>
            );
          })}
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
        <div className="space-y-3">
          <NativeSelectRow
            label={t("settings.ai.namedChains.defaultChainLabel")}
            hint={t("settings.ai.namedChains.defaultChainHint")}
            value={draft.defaultChainId ?? ""}
            onChange={(value) => {
              setMsg(null);
              setDraft((prev) => ({ ...prev, defaultChainId: value || null }));
            }}
            options={[
              { value: "", label: mainName },
              ...draft.chains.map((c) => ({
                value: c.id,
                label: c.name.trim() || "…",
              })),
            ]}
          />
        </div>
      )}

      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {t("settings.ai.namedChains.tasksHeading")}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.namedChains.tasksHint")}
        </p>
      </div>
      <ul className="divide-border divide-y" data-slot="named-chain-tasks">
        {NAMED_CHAIN_CAPABILITIES.map((capability) => {
          const attached = draft.chains.find(
            (c) => c.id === draft.attachments[capability],
          );
          const entries = attached?.entries ?? defaultEntries;
          return (
            <li
              key={capability}
              data-capability={capability}
              className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-sm font-medium">
                  {t(`settings.ai.namedChains.capabilities.${capability}`)}
                </p>
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {entries.map((type) => (
                    <li key={type} className="text-muted-foreground text-xs">
                      <EgressLabel
                        name={providerName(type)}
                        egress={providerInfo.get(type)?.egress ?? "external"}
                      />
                    </li>
                  ))}
                </ul>
                {attached && attached.entries.length === 1 && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t("settings.ai.namedChains.bindingShort")}
                  </p>
                )}
              </div>
              <NativeSelect
                aria-label={t(
                  `settings.ai.namedChains.capabilities.${capability}`,
                )}
                value={attached?.id ?? ""}
                onChange={(e) => attach(capability, e.target.value)}
                className="w-full sm:w-48"
                disabled={draft.chains.length === 0}
              >
                <option value="">
                  {t("settings.ai.namedChains.taskDefault")}
                </option>
                {draft.chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name.trim() || "…"}
                  </option>
                ))}
              </NativeSelect>
            </li>
          );
        })}
      </ul>

      {(msg || nameProblem) && (
        <p
          className={`text-xs ${ok && !nameProblem ? "text-success" : "text-destructive"}`}
        >
          {nameProblem ?? msg}
        </p>
      )}
      <SettingsCardActions>
        <Button
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => save.mutate(draft)}
          disabled={save.isPending || nameProblem !== null}
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

function swap<T>(list: readonly T[], a: number, b: number): T[] {
  if (b < 0 || b >= list.length) return [...list];
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

function EgressLabel({
  name,
  egress,
}: {
  name: string;
  egress: "local" | "external";
}) {
  const { t } = useTranslations();
  const Icon = egress === "local" ? HardDrive : Cloud;
  const where =
    egress === "local"
      ? t("settings.ai.namedChains.egressLocal")
      : t("settings.ai.namedChains.egressExternal");
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {name}
        <span className="sr-only">: {where}</span>
      </span>
    </span>
  );
}

function EntryMeta({
  egress,
  available,
}: {
  egress: "local" | "external";
  available: boolean;
}) {
  const { t } = useTranslations();
  const Icon = egress === "local" ? HardDrive : Cloud;
  return (
    <p className="text-muted-foreground inline-flex flex-wrap items-center gap-x-2 text-xs">
      <span className="inline-flex items-center gap-1">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {egress === "local"
          ? t("settings.ai.namedChains.egressLocal")
          : t("settings.ai.namedChains.egressExternal")}
      </span>
      {!available && <span>{t("settings.ai.namedChains.notSetUp")}</span>}
    </p>
  );
}

function NativeSelectRow({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <NativeSelect
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full sm:w-64"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
      <span className="text-muted-foreground block text-xs">{hint}</span>
    </label>
  );
}

function AddEntry({
  options,
  onAdd,
}: {
  options: readonly string[];
  onAdd: (type: NamedChainView["entries"][number]) => void;
}) {
  const { t } = useTranslations();
  const [picked, setPicked] = useState<string>("");
  const value = options.includes(picked) ? picked : (options[0] ?? "");
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label={t("settings.ai.providerChain.addProvider")}
        value={value}
        onChange={(e) => setPicked(e.target.value)}
        className="w-auto"
      >
        {options.map((type) => (
          <option key={type} value={type}>
            {t(`settings.ai.providerChain.types.${type}`)}
          </option>
        ))}
      </NativeSelect>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-11 sm:min-h-9"
        onClick={() => onAdd(value as NamedChainView["entries"][number])}
      >
        <PlusCircle className="h-4 w-4" />
        {t("settings.ai.providerChain.addProvider")}
      </Button>
    </div>
  );
}
