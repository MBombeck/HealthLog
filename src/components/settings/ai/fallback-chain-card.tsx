"use client";

/* ────────────────────────────────────────────────────────────────
 * Fallback chain card — reorder via arrows, toggle, remove, add,
 * reset. Uses no new dependency (dnd-kit isn't in package.json).
 * ──────────────────────────────────────────────────────────────── */

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ListOrdered,
  Loader2,
  PlusCircle,
  RotateCcw,
  Save,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { apiPut } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { aiInputDependentKeys, invalidateKeys } from "@/lib/query-keys";

import {
  DEFAULT_CHAIN,
  PROVIDER_TYPES,
  isProviderType,
  type ChainEntry,
  type ProviderType,
} from "./shared";

export function FallbackChainCard({
  chain,
  selected,
  onSelect,
}: {
  chain: {
    providerType: ProviderType;
    enabled: boolean;
    available: boolean;
  }[];
  selected: ProviderType;
  onSelect: (next: ProviderType) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // Local working copy. Server-confirmed values arrive via `chain`
  // prop; we keep our own state so the user can shuffle multiple rows
  // before clicking "Save chain order".
  // v1.4.16 phase D reconcile (code-review H2) — `enabled` from the
  // wire is now the canonical state. The GET endpoint surfaces the
  // raw persisted chain so a disabled entry survives the round-trip.
  const seededKey = chain
    .map((c) => `${c.providerType}:${c.enabled ? 1 : 0}`)
    .join(",");
  const [seeded, setSeeded] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChainEntry[]>(() =>
    chain.map((c) => ({ providerType: c.providerType, enabled: c.enabled })),
  );
  if (seededKey !== seeded) {
    setSeeded(seededKey);
    setEntries(
      chain.map((c) => ({
        providerType: c.providerType,
        enabled: c.enabled,
      })),
    );
  }

  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async (next: ChainEntry[]) => {
      const body = {
        chain: next.map((entry, idx) => ({
          providerType: entry.providerType,
          priority: idx + 1,
          enabled: entry.enabled,
        })),
      };
      await apiPut("/api/insights/provider-chain", body);
    },
    onSuccess: () => {
      setOk(true);
      setMsg(t("settings.ai.providerChain.saved"));
      void invalidateKeys(queryClient, aiInputDependentKeys);
    },
    onError: (e) => {
      setOk(false);
      setMsg(
        e instanceof Error
          ? e.message
          : t("settings.ai.providerChain.saveFailed"),
      );
    },
  });

  function move(idx: number, delta: -1 | 1) {
    setEntries((prev) => {
      const next = [...prev];
      const target = idx + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function toggle(idx: number) {
    setEntries((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], enabled: !next[idx].enabled };
      return next;
    });
  }

  function remove(idx: number) {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
  }

  const present = useMemo(
    () => new Set(entries.map((e) => e.providerType)),
    [entries],
  );
  const addable = PROVIDER_TYPES.filter((p) => !present.has(p));

  function add(p: ProviderType) {
    setEntries((prev) => [...prev, { providerType: p, enabled: true }]);
  }

  function resetToDefaults() {
    setEntries(DEFAULT_CHAIN.map((d) => ({ ...d })));
  }

  return (
    <SettingsCard data-testid="ai-fallback-chain">
      <SettingsCardHeader
        anchor="provider-chain"
        icon={ListOrdered}
        title={t("settings.ai.providerChain.title")}
        description={t("settings.ai.providerChain.description")}
      />

      <ul className="space-y-2">
        {entries.map((entry, idx) => (
          <li
            key={entry.providerType}
            data-chain-row={entry.providerType}
            className={`bg-card border-border flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border p-2 ${
              entry.providerType === selected
                ? "border-primary/40 ring-primary/30 ring-1"
                : ""
            }`}
          >
            <span className="text-muted-foreground w-5 text-center text-xs tabular-nums">
              {idx + 1}.
            </span>
            {/* The name keeps its own line on a phone and the controls wrap
                under it, right-aligned; squeezed beside five controls it
                broke a three-word name over three lines. */}
            <button
              type="button"
              onClick={() => onSelect(entry.providerType)}
              className="min-w-0 flex-1 basis-[calc(100%-2rem)] text-left text-sm font-medium hover:underline sm:basis-0"
            >
              {t(`settings.ai.providerChain.types.${entry.providerType}`)}
            </button>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Switch
                checked={entry.enabled}
                onCheckedChange={() => toggle(idx)}
                aria-label={t(
                  `settings.ai.providerChain.types.${entry.providerType}`,
                )}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t("settings.ai.providerChain.moveUp")}
                disabled={idx === 0}
                onClick={() => move(idx, -1)}
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t("settings.ai.providerChain.moveDown")}
                disabled={idx === entries.length - 1}
                onClick={() => move(idx, 1)}
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t("settings.ai.providerChain.removeFromChain")}
                className="text-destructive min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                onClick={() => remove(idx)}
                disabled={entries.length <= 1}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {addable.length > 0 ? (
          <AddProviderControl addable={addable} onAdd={add} />
        ) : (
          <p className="text-muted-foreground text-xs italic">
            {t("settings.ai.providerChain.addNoneAvailable")}
          </p>
        )}
      </div>

      {msg && (
        <p className={`text-xs ${ok ? "text-success" : "text-destructive"}`}>
          {msg}
        </p>
      )}
      <SettingsCardActions>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9">
              <RotateCcw className="h-4 w-4" />
              {t("settings.ai.providerChain.resetDefaults")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.ai.providerChain.resetConfirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.ai.providerChain.resetConfirmBody")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={resetToDefaults}>
                {t("settings.ai.providerChain.resetDefaults")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => saveMutation.mutate(entries)}
          disabled={saveMutation.isPending || entries.length === 0}
          data-testid="ai-fallback-chain-save"
        >
          {saveMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {t("settings.ai.providerChain.saveOrder")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}

function AddProviderControl({
  addable,
  onAdd,
}: {
  addable: readonly ProviderType[];
  onAdd: (p: ProviderType) => void;
}) {
  const { t } = useTranslations();
  const [picked, setPicked] = useState<string>(addable[0] ?? "");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label={t("settings.ai.providerChain.addProvider")}
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        className="w-auto"
      >
        {addable.map((p) => (
          <option key={p} value={p}>
            {t(`settings.ai.providerChain.types.${p}`)}
          </option>
        ))}
      </NativeSelect>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-11 sm:min-h-9"
        onClick={() => {
          if (isProviderType(picked)) onAdd(picked);
        }}
      >
        <PlusCircle className="h-4 w-4" />
        {t("settings.ai.providerChain.addProvider")}
      </Button>
    </div>
  );
}
